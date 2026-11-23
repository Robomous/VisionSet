/**
 * What the Images sheet's scroll position means, per source: which heading is
 * pinned, and which images of the source at the top are on screen. Read once
 * per frame while the sheet scrolls or resizes, and set only when it changed,
 * so scrolling re-renders the headings and nothing else.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

export interface ScrollSpy {
  /** The source whose images fill the top of the sheet. */
  readonly current: string | null;
  /** Sources whose heading is pinned at the top. */
  readonly stuck: readonly string[];
  /** Which images of the current source are on screen, 1-based, against its total. */
  readonly range: { readonly from: number; readonly to: number } | null;
}

const NONE: ScrollSpy = { current: null, stuck: [], range: null };

/**
 * `covered` is how much of the top a pinned heading hides, so "on screen" means
 * below it. `version` changes whenever the sheet's content does — what is shown,
 * how much has arrived, the layout — so the spy measures again.
 */
export function useScrollSpy(sheet: RefObject<HTMLElement | null>, covered: number, version: string): ScrollSpy {
  const [state, setState] = useState<ScrollSpy>(NONE);
  const last = useRef("");

  useEffect(() => {
    const el = sheet.current;
    if (el === null) return;
    let frame = 0;

    function measure(): void {
      frame = 0;
      if (el === null) return;
      const top = el.getBoundingClientRect().top;
      const bottom = top + el.clientHeight;
      const sections = [...el.querySelectorAll<HTMLElement>("section[data-source]")];
      const stuck: string[] = [];
      let current: HTMLElement | undefined;
      for (const s of sections) {
        const r = s.getBoundingClientRect();
        if (r.top < top - 0.5 && r.bottom > top + covered) stuck.push(s.dataset["source"] ?? "");
        if (r.top - top <= covered + 8) current = s;
      }
      // At the very end the last source is the one being read, however short.
      const end = sections.at(-1);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2 && end !== undefined && end.getBoundingClientRect().top < bottom) current = end;
      current ??= sections[0];

      let range: ScrollSpy["range"] = null;
      if (current !== undefined) {
        let from = -1;
        let to = -1;
        current.querySelectorAll<HTMLElement>("[role=option]").forEach((tile, i) => {
          const r = tile.getBoundingClientRect();
          if (r.bottom > top + covered + 4 && r.top < bottom - 4) {
            if (from === -1) from = i;
            to = i;
          }
        });
        if (from !== -1) range = { from: from + 1, to: to + 1 };
      }

      const next: ScrollSpy = { current: current?.dataset["source"] ?? null, stuck, range };
      const signature = JSON.stringify(next);
      if (signature !== last.current) {
        last.current = signature;
        setState(next);
      }
    }

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    // Absent in some test environments; the scroll listener still covers the page.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [sheet, covered, version]);

  return state;
}
