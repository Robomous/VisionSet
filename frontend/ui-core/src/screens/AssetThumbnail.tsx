/**
 * One asset's cached preview.
 *
 * ## An `<img src>` cannot fetch this, and that is the finding
 *
 * `GET /projects/{p}/assets/{a}/thumbnail` is a **protected route** — every route
 * but `/health` and `/openapi.json` is — and it authenticates with
 * `Authorization: Bearer`. An `<img src="…">` sends no such header. The browser
 * issues that request itself, with cookies and nothing else, so pointing an
 * `<img>` at the route produces a 401 and a broken-image icon on every tile.
 *
 * There is no cookie session to fall back on and the API accepts no token in the
 * query string, so the only way through is to fetch the bytes with the credentialed
 * client and hand the result to the `<img>` as an object URL. That is what this
 * component is; everything else about it is bookkeeping for that one fact.
 *
 * The cost is smaller than it looks. `docs/content/api.md` gives the route
 * `Cache-Control: public, max-age=31536000, immutable` with the content hash as its
 * `ETag`, so the second request for a preview is served from the browser's own HTTP
 * cache — a `fetch` gets that as much as an `<img>` does.
 *
 * ## A NULL `thumbnail_hash` is a state, not a failure
 *
 * A preview that would not render is deliberately **not** an `IngestFailure`: the
 * asset exists and nothing was lost, so the hash stays NULL and the run's report
 * stays empty. Assets ingested before the thumbnail cache existed are NULL too.
 * Either way the remedy — `backfill_thumbnails` — is reachable only from the CLI
 * and MCP, so the gallery states the situation and does not offer a button it
 * cannot wire up.
 *
 * ## The object URL is revoked, and it has to be
 *
 * Every `createObjectURL` pins its blob in memory until `revokeObjectURL`. A
 * gallery scrolling a thousand assets would hold a thousand JPEGs alive with
 * nothing referencing them — the leak is invisible until it is a tab using two
 * gigabytes.
 */

import { Image as ImageIcon, ImageOff } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { useApiClient } from "../data/ApiProvider";

export interface ThumbnailPlaceholderProps {
  /** What a pointer hover should say about why there is no picture here. */
  readonly title: string;
  readonly alt: string;
  /** A fetch that failed earns the crossed-out icon; an absence never does. */
  readonly broken?: boolean;
  readonly className?: string;
}

/**
 * The muted stand-in every thumbnail surface shares.
 *
 * Extracted so a caller with *no asset at all* — a project that has never
 * ingested an image — can render the same box with its own explanation,
 * rather than borrowing this component's "not cached" story for a situation
 * it does not describe.
 */
export function ThumbnailPlaceholder({
  title,
  alt,
  broken = false,
  className,
}: ThumbnailPlaceholderProps): JSX.Element {
  return (
    <div
      data-testid="thumbnail-placeholder"
      title={title}
      className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}
    >
      {broken ? (
        <ImageOff className="size-5" aria-hidden="true" />
      ) : (
        <ImageIcon className="size-5" aria-hidden="true" />
      )}
      <span className="sr-only">{alt}</span>
    </div>
  );
}

export interface AssetThumbnailProps {
  readonly projectId: string;
  readonly assetId: string;
  /** `null` when the preview was never cached. Rendered as a placeholder. */
  readonly thumbnailHash: string | null | undefined;
  readonly alt: string;
  readonly className?: string;
}

export function AssetThumbnail({
  projectId,
  assetId,
  thumbnailHash,
  alt,
  className,
}: AssetThumbnailProps): JSX.Element {
  const client = useApiClient();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (thumbnailHash === null || thumbnailHash === undefined) return;
    // Aborted rather than raced: a fast scroll unmounts tiles mid-flight, and
    // `live = false` only discarded the result — the transfer itself ran to
    // completion for every tile scrolled past (#572). The controller cancels
    // it, and doubles as the "has this render been superseded?" flag.
    const controller = new AbortController();
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const result = await client.GET("/projects/{project_id}/assets/{asset_id}/thumbnail", {
          params: { path: { project_id: projectId, asset_id: assetId } },
          // The route answers `image/jpeg`; without this `openapi-fetch` tries to
          // parse it as JSON and every tile fails on a syntax error.
          parseAs: "blob",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.error !== undefined || result.data === undefined) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(result.data as unknown as Blob);
        setUrl(objectUrl);
      } catch {
        // The abort lands here by design; anything else is a dead network,
        // which is the one case that earns the crossed-out icon.
        if (!controller.signal.aborted) setFailed(true);
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [client, projectId, assetId, thumbnailHash]);

  if (thumbnailHash === null || thumbnailHash === undefined || failed) {
    // A preview that was never cached is not a preview that broke, and
    // `DESIGN.md` forbids a broken-image glyph for the first. NULL is the
    // ordinary state of an asset ingested before the cache existed or one
    // whose bytes would not render — the asset is fine. A fetch that
    // actually failed keeps the crossed-out icon, because that one *is* a
    // failure.
    return (
      <ThumbnailPlaceholder
        title={
          failed
            ? "The preview could not be loaded."
            : "No cached preview. `visionset` can backfill one; there is no button for it here."
        }
        alt={alt}
        broken={failed}
        className={className}
      />
    );
  }

  if (url === null) {
    return <div data-testid="thumbnail-loading" className={`animate-pulse bg-muted ${className ?? ""}`} />;
  }

  return (
    <img
      data-testid="thumbnail"
      src={url}
      alt={alt}
      className={className}
      loading="lazy"
      // The browser's native image drag lifts a ghost of the picture out of any
      // tile — inside a grid whose press means *open this frame*, a drag
      // that grabs the image instead is a gesture the product never means. The
      // attribute is the whole enforcement: an `<img draggable={false}>` starts
      // no native drag in any engine this product supports, and a second guard
      // behind it would be the untestable double `AnnotatorPanel` refuses.
      draggable={false}
    />
  );
}
