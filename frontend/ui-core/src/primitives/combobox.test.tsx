import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "./combobox";

const FRUIT = ["apple", "banana", "cherry"];

function Demo() {
  return (
    <Combobox items={FRUIT}>
      <ComboboxInput placeholder="Pick" aria-label="Fruit" />
      <ComboboxContent>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>{(item: string) => <ComboboxItem key={item} value={item}>{item}</ComboboxItem>}</ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

describe("combobox", () => {
  it("filters as you type and offers the survivors as options", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const input = screen.getByRole("combobox", { name: "Fruit" });
    await user.type(input, "an");
    expect(await screen.findByRole("option", { name: "banana" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "cherry" })).toBeNull();
  });
  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const input = screen.getByRole("combobox", { name: "Fruit" });
    await user.type(input, "a");
    await screen.findByRole("option", { name: "apple" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option", { name: "apple" })).toBeNull();
  });
});
