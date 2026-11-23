/** What a release's on-demand verification found, carried over as it was. */

import { Check } from "lucide-react";
import type { JSX } from "react";

import { Alert, AlertDescription, AlertTitle } from "@robomous/ui-core";

/**
 * What `verify` found.
 *
 * `manifest_intact: false` is reported first and on its own: when the manifest's
 * own bytes fail its hash the service stops with `checked: 0`, so every other
 * number is about nothing. `cache_mismatches` is its own line too — the release
 * row's counts are an explicit read cache over the manifest, and the two
 * disagreeing is a different problem from a blob being gone.
 */
export function Verification({
  report,
  tag,
}: {
  readonly report: {
    readonly ok: boolean;
    readonly manifest_intact: boolean;
    readonly checked: number;
    readonly missing: readonly string[];
    readonly corrupt: readonly string[];
    readonly cache_mismatches: readonly string[];
  };
  readonly tag: string;
}): JSX.Element {
  if (!report.manifest_intact) {
    return (
      <Alert variant="destructive" data-testid={`verified-${tag}`}>
        <AlertTitle>The manifest itself does not match its hash</AlertTitle>
        <AlertDescription>
        Nothing else could be checked — every count in this release is derived from a
        document that is not the one its hash names.
        </AlertDescription>
      </Alert>
    );
  }
  if (report.ok) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`verified-${tag}`}>
        <Check className="size-3.5" aria-hidden="true" />
        {report.checked} blobs re-read and re-hashed. Intact.
      </p>
    );
  }
  return (
    <Alert variant="destructive" data-testid={`verified-${tag}`}>
      <AlertTitle>This release cannot be reproduced</AlertTitle>
      <AlertDescription>
      {report.missing.length} missing · {report.corrupt.length} corrupt ·{" "}
      {report.cache_mismatches.length} cache mismatch
      {report.cache_mismatches.length === 1 ? "" : "es"} of {report.checked} checked.
      </AlertDescription>
    </Alert>
  );
}
