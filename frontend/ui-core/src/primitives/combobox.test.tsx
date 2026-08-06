/**
 * The combobox primitive: filtering, the four keys, and the footer row.
 *
 * Written against the primitive rather than through `ClassField`, because the
 * behaviour is the primitive's and the field is one caller of it. What the field
 * adds — swatches, hotkeys, recency ordering, "create this class" — is asserted
 * in `classField.test.tsx`.
 */

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState, type JSX } from "react";

import { Combobox, type ComboboxFooter } from "./Combobox";

const FRUIT = ["apricot", "Banana", "cherry", "blackcurrant"];

/** The primitive with `open` hoisted, which is how every caller drives it. */
function Harness({
  onSelect,
  footer,
  items = FRUIT,
}: {
  readonly onSelect?: (item: string) => void;
  readonly footer?: (query: string) => ComboboxFooter | null;
  readonly items?: readonly string[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Combobox
      label="Fruit"
      trigger={<span>Pick one</span>}
      items={items}
      itemKey={(item) => item}
      itemLabel={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      onSelect={onSelect ?? (() => {})}
      open={open}
      onOpenChange={setOpen}
      {...(footer === undefined ? {} : { footer })}
    />
  );
}

async function openIt(): Promise<void> {
  await userEvent.click(screen.getByTestId("combobox-trigger"));
  expect(await screen.findByTestId("combobox-input")).toBeDefined();
}

describe("filtering", () => {
  it("matches anywhere in the label, not only at the start", async () => {
    // Substring, deliberately: a person hunting `blackcurrant` in a forty-class
    // schema is as likely to type `currant` as `black`.
    render(<Harness />);
    await openIt();
    await userEvent.type(screen.getByTestId("combobox-input"), "curr");

    expect(screen.getByTestId("combobox-option-blackcurrant")).toBeDefined();
    expect(screen.queryByTestId("combobox-option-cherry")).toBeNull();
  });

  it("ignores case in both directions", async () => {
    render(<Harness />);
    await openIt();
    await userEvent.type(screen.getByTestId("combobox-input"), "BAN");

    expect(screen.getByTestId("combobox-option-Banana")).toBeDefined();
  });

  it("says so when nothing matches, rather than rendering an empty box", async () => {
    render(<Harness />);
    await openIt();
    await userEvent.type(screen.getByTestId("combobox-input"), "durian");

    expect(screen.getByTestId("combobox-empty")).toBeDefined();
  });

  it("starts from the whole list again on every open", async () => {
    // A picker that reopened holding the last query would make the second use of
    // it a puzzle: the list is short for a reason nobody can see.
    render(<Harness />);
    await openIt();
    await userEvent.type(screen.getByTestId("combobox-input"), "ban");
    await userEvent.keyboard("{Escape}");

    await openIt();
    expect((screen.getByTestId("combobox-input") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("option")).toHaveLength(FRUIT.length);
  });
});

describe("the keyboard", () => {
  it("walks the list with the arrows and takes the row Enter is on", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await openIt();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(onSelect).toHaveBeenCalledWith("cherry");
  });

  it("wraps at both ends, because the last row is the one worth reaching", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await openIt();

    // Up from the first row lands on the last.
    await userEvent.keyboard("{ArrowUp}{Enter}");

    expect(onSelect).toHaveBeenCalledWith("blackcurrant");
  });

  it("closes on Escape without selecting anything", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await openIt();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByTestId("combobox-input")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the ring inside the list as typing shortens it", async () => {
    // Clamped rather than reset: narrowing six rows to two should leave the
    // highlight on the last one, not throw it back to the top.
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await openIt();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    // `an` matches two — "Banana" and "black-curr-ant" — so the list goes from
    // four rows to two with the ring sitting past the end of it.
    await userEvent.type(screen.getByTestId("combobox-input"), "an");
    await userEvent.keyboard("{Enter}");

    // The **last** of the two, not the first: clamped back inside the list
    // rather than reset to the top, which is what would have happened if the
    // filter simply zeroed the ring.
    expect(onSelect).toHaveBeenCalledWith("blackcurrant");
  });
});

describe("the footer row", () => {
  const creating = (query: string): ComboboxFooter | null =>
    query === "" ? null : { label: `Create "${query}"`, onSelect: () => {} };

  it("appears only once something is typed", async () => {
    render(<Harness footer={creating} />);
    await openIt();
    expect(screen.queryByTestId("combobox-footer")).toBeNull();

    await userEvent.type(screen.getByTestId("combobox-input"), "durian");
    expect(screen.getByTestId("combobox-footer").textContent).toBe('Create "durian"');
  });

  it("is an option, so the arrows reach it", async () => {
    // The whole reason it is a `role="option"` in the listbox rather than a
    // button underneath: it exists for the state where nothing matched, which is
    // exactly when a keyboard user has nowhere else to go.
    const create = vi.fn();
    render(<Harness footer={(query) => (query === "" ? null : { label: "Create", onSelect: create })} />);
    await openIt();
    await userEvent.type(screen.getByTestId("combobox-input"), "durian");
    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("is the only row when the filter matched nothing, and Enter takes it", async () => {
    const create = vi.fn();
    render(<Harness footer={(query) => (query === "" ? null : { label: "Create", onSelect: create })} />);
    await openIt();
    await userEvent.type(screen.getByTestId("combobox-input"), "durian");
    await userEvent.keyboard("{Enter}");

    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("combobox-empty")).toBeNull();
  });
});

describe("the ARIA contract", () => {
  it("names the listbox it controls and the option the ring is on", async () => {
    render(<Harness />);
    await openIt();

    const field = screen.getByTestId("combobox-input");
    const list = screen.getByRole("listbox");
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(field.getAttribute("aria-controls")).toBe(list.id);
    // The active descendant is what a screen reader announces as the cursor
    // moves; without it the arrows move a highlight nobody is told about.
    expect(field.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id,
    );

    await userEvent.keyboard("{ArrowDown}");
    expect(field.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1].id,
    );
  });

  it("marks exactly one option selected at a time", async () => {
    render(<Harness />);
    await openIt();
    await userEvent.keyboard("{ArrowDown}");

    const selected = screen
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe("Banana");
  });

  it("says it is collapsed while it is", () => {
    render(<Harness />);
    expect(screen.getByTestId("combobox-trigger").getAttribute("aria-expanded")).toBe("false");
  });
});
