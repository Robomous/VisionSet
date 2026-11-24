/**
 * A withheld icon button, tested for what it keeps and what it refuses: it stays
 * focusable so its tooltip can say why, and no press does anything — not its own,
 * and not a Radix trigger's.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Check } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Popover, PopoverContent, PopoverTrigger, TooltipProvider } from "@robomous/ui-core";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { IconAction, IconButton } from "./IconAction";

beforeEach(() => stubResizeObserver());

describe("IconAction", () => {
  it("presses when it is offered", async () => {
    const pressed = vi.fn();
    render(
      <TooltipProvider>
        <IconAction icon={Check} label="Do it" data-testid="act" onClick={pressed} />
      </TooltipProvider>,
    );
    const button = screen.getByTestId("act");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(button);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("stays focusable when withheld, says why, and refuses the press", async () => {
    const pressed = vi.fn();
    render(
      <TooltipProvider>
        <IconAction icon={Check} label="Do it" reason="Not yet" data-testid="act" onClick={pressed} />
      </TooltipProvider>,
    );
    const button = screen.getByTestId("act");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    expect((await screen.findAllByText("Not yet")).length).toBeGreaterThan(0);
    await userEvent.click(button);
    expect(pressed).not.toHaveBeenCalled();
  });

  it("is withheld while a request is in flight", () => {
    render(
      <TooltipProvider>
        <IconAction icon={Check} label="Do it" busy data-testid="act" />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("act").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("act").getAttribute("aria-busy")).toBe("true");
  });

  it("keeps a Radix trigger from acting while withheld", async () => {
    render(
      <TooltipProvider>
        <Popover>
          <PopoverTrigger asChild>
            <IconButton icon={Check} label="Open" reason="Not yet" data-testid="trigger" />
          </PopoverTrigger>
          <PopoverContent data-testid="content">Opened</PopoverContent>
        </Popover>
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByTestId("trigger"));
    expect(screen.queryByTestId("content")).toBeNull();
  });
});
