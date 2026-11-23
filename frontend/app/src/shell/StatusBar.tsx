/**
 * The status bar: the workbench's bottom line, for what is true right now.
 *
 * **Two halves: this page at the left, the workspace at the right.**
 *
 * The left is the page's own: what the list on screen holds and adds up to —
 * *2 of 4 models · 3 ready*, *2 projects · 61 assets · 11 to annotate* — written
 * there by the screen through `PageStatus`, so the page itself does not say it
 * again beside its heading or in a totals row.
 *
 * The right is the workspace's, the same on every page: any weight download
 * that is running — with its progress, so a download started on Models and left
 * to run stays visible from every other page — how many model connections are
 * ready to pre-label with, and which credential this page is using (the
 * session's own answer). Clicking the models summary goes to Models, where they
 * are managed; the bar itself changes nothing.
 *
 * **On Models the workspace's model facts step aside**: the page's grid shows
 * every state and every run in flight, and its own summary in the left half
 * counts the ready ones, so saying them again at the right would be the bar
 * repeating the page.
 *
 * Nothing here decides what is legal. "Ready" is the connection's own
 * `setup_state`, and "downloading" is the run's own state through `isLive`, the
 * same predicate the Models screen polls on — so the two never disagree about
 * whether something is in flight. `useConnections` already re-reads while a run
 * is live, so the bar follows a download without a poll of its own.
 *
 * Standalone-shell chrome, like the rail: a host that mounts VisionSet's screens
 * brings its own frame.
 */

import { formatCount, isLive, PageStatusOutlet, ProgressReadout, useConnections, type Connection } from "@visionset/ui-core";
import { Link, useLocation } from "react-router";
import type { JSX } from "react";

import { useOssSession } from "../data/OssSession";

export function StatusBar(): JSX.Element {
  const { access } = useOssSession();
  const connections = useConnections();
  const items = connections.data?.items ?? [];
  const ready = items.filter((c) => c.setup_state === "ready").length;
  const downloading = items.filter((c) => isLive(c.download));
  // Models shows these itself, row by row; see the note above.
  const onModels = useLocation().pathname.startsWith("/models");

  return (
    <footer
      data-testid="status-bar"
      // `px-4 md:px-6` is `PaddedContent`'s gutter, so the bar's first word sits
      // on the page column's left edge at every width.
      className="sticky bottom-0 z-20 flex h-7 shrink-0 items-center gap-4 border-t bg-sidebar px-4 text-xs text-muted-foreground tabular-nums md:px-6"
    >
      <PageStatusOutlet />

      <span className="ml-auto flex min-w-0 items-center gap-4">
        {!onModels && downloading.map((c) => <Download key={c.id} connection={c} />)}

        {!onModels && (
          <Link
            to="/models"
            data-testid="status-models"
            className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {connections.isPending
              ? "Models…"
              : connections.isError
                ? "Models unavailable"
                : items.length === 0
                  ? "No models connected"
                  : `${ready} of ${items.length} ${items.length === 1 ? "model" : "models"} ready`}
          </Link>
        )}

        {/* No health dot: one failed read is not proof the server is down, and a
            green dot nobody re-checks is a claim the bar cannot keep. */}
        {/* Truncates rather than pushing past a 320px window: the last thing the bar can give up. */}
        <span data-testid="status-access" className="min-w-0 truncate">
          Local workspace · {access === "session" ? "browser session" : "token"}
        </span>
      </span>
    </footer>
  );
}

function Download({ connection }: { readonly connection: Connection }): JSX.Element {
  const run = connection.download;
  const done = run?.bytes_done ?? 0;
  const total = run?.bytes_total ?? null;
  const pct = total !== null && total > 0 ? Math.round((done / total) * 100) : null;
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid={`status-download-${connection.name}`}>
      <span className="truncate">Downloading {connection.name}</span>
      {/* An unknown total is said as bytes so far, never as a bar that pretends to know. */}
      {pct === null ? (
        <span className="tabular-nums">{formatCount(Math.round(done / 1_000_000))} MB</span>
      ) : (
        // The share, then its ring — the app's one way of saying how far along.
        <ProgressReadout value={pct} total={100}>
          <span className="inline-block w-8 text-right">{pct}%</span>
        </ProgressReadout>
      )}
    </span>
  );
}
