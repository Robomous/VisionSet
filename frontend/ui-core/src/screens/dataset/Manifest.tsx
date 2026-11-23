/**
 * A release's manifest hash, short, with its two icon buttons: a copy that
 * says it copied, and the download of the manifest file.
 */

import { Check, Copy, Download } from "lucide-react";
import { useState, type JSX } from "react";

import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";

/** 28px drawn; the hit area reaches 40px, and two side by side never overlap. */
const HIT = "relative shrink-0 text-muted-foreground after:absolute after:-inset-1.5 hover:text-foreground";

export function Manifest({
  hash,
  onDownload,
  downloading = false,
  downloadTestId,
}: {
  readonly hash: string;
  /** Saves the manifest file; the button is left out without it. */
  readonly onDownload?: () => void;
  readonly downloading?: boolean;
  readonly downloadTestId?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex w-full min-w-0 items-center gap-1">
      <span className="mr-auto min-w-0 truncate font-mono text-xs" title={hash}>
        {hash.slice(0, 16)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className={HIT}
        aria-label={copied ? "Copied" : "Copy the manifest hash"}
        onClick={() => {
          void navigator.clipboard?.writeText(hash);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <Check aria-hidden="true" className="text-success" /> : <Copy aria-hidden="true" />}
      </Button>
      {onDownload !== undefined && (
        <Tooltip delayDuration={400}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className={HIT} aria-label="Download the manifest" data-testid={downloadTestId} disabled={downloading} onClick={onDownload}>
              <Download aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            Download the manifest
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
