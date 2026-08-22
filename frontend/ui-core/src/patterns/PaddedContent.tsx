/**
 * The padded, centred column every list, form and dashboard reads in.
 *
 * One declaration, consumed by the app's padded pane and by the project shell's
 * content area, so the two cannot disagree on how wide a page is.
 */

import type { JSX, ReactNode } from "react";

export function PaddedContent({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[112rem]">{children}</div>
    </div>
  );
}
