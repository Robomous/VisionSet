/**
 * The bar's forward step — the control marked `data-autofocus`: Approve, Start
 * annotating, Annotate, Complete batch, Add to dataset — as the State property
 * offers it beside the chip. Read off the bar rather than decided again, so the
 * field says exactly what the bar does: the same name, and nothing at all while
 * the bar withholds it (`disabled` or `aria-disabled`; the bar says why).
 * Pressing it presses the bar's own control, so its gating, dialogs, refusals
 * and outcome are the ones that control already has.
 */

import { useEffect, useState, type RefObject } from "react";

export interface ForwardStep {
  readonly label: string;
  readonly press: () => void;
}

export function useForwardStep(bar: RefObject<HTMLElement | null>): ForwardStep | null {
  const [step, setStep] = useState<{ readonly label: string; readonly control: HTMLElement } | null>(null);

  useEffect(() => {
    const at = bar.current;
    if (at === null) return undefined;
    const read = (): void => {
      const control = at.querySelector<HTMLElement>("[data-autofocus]");
      const live = control !== null && !control.matches(":disabled, [aria-disabled='true']");
      const label = live ? (control.getAttribute("aria-label") ?? control.textContent ?? "").trim() : "";
      setStep((was) => {
        if (!live || label === "") return null;
        return was?.control === control && was.label === label ? was : { label, control };
      });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(at, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-autofocus", "aria-disabled", "disabled", "aria-label"],
    });
    return () => observer.disconnect();
  }, [bar]);

  return step === null ? null : { label: step.label, press: () => step.control.click() };
}
