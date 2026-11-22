/** A release's manifest hash, short, and a copy that says it copied. */

import { Check, Copy } from "lucide-react";
import { useState, type JSX } from "react";

import { Button } from "@robomous/ui-core";

export function Manifest({ hash }: { readonly hash: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-mono text-xs" title={hash}>
        {hash.slice(0, 16)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        // 28px drawn; the hit area reaches 40px.
        className="relative shrink-0 after:absolute after:-inset-1.5"
        aria-label={copied ? "Copied" : "Copy the manifest hash"}
        onClick={() => {
          void navigator.clipboard?.writeText(hash);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <Check aria-hidden="true" className="text-success" /> : <Copy aria-hidden="true" />}
      </Button>
    </span>
  );
}
