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
 * The cost is smaller than it looks. `docs/api.md` gives the route
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
    // Cancelled rather than raced: a fast scroll unmounts tiles mid-flight, and a
    // late response setting state on a gone component is the classic leak warning.
    let live = true;
    let objectUrl: string | null = null;

    void (async () => {
      const result = await client.GET("/projects/{project_id}/assets/{asset_id}/thumbnail", {
        params: { path: { project_id: projectId, asset_id: assetId } },
        // The route answers `image/jpeg`; without this `openapi-fetch` tries to
        // parse it as JSON and every tile fails on a syntax error.
        parseAs: "blob",
      });
      if (!live) return;
      if (result.error !== undefined || result.data === undefined) {
        setFailed(true);
        return;
      }
      objectUrl = URL.createObjectURL(result.data as unknown as Blob);
      setUrl(objectUrl);
    })();

    return () => {
      live = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [client, projectId, assetId, thumbnailHash]);

  if (thumbnailHash === null || thumbnailHash === undefined || failed) {
    return (
      <div
        data-testid="thumbnail-placeholder"
        title={
          failed
            ? "The preview could not be loaded."
            : "No cached preview. `visionset` can backfill one; there is no button for it here."
        }
        className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}
      >
        {/* A preview that was never cached is not a preview that broke, and
            `DESIGN.md` forbids a broken-image glyph for the first. NULL is the
            ordinary state of an asset ingested before the cache existed or one
            whose bytes would not render — the asset is fine. A fetch that
            actually failed keeps the crossed-out icon, because that one *is* a
            failure. */}
        {failed ? (
          <ImageOff className="size-5" aria-hidden="true" />
        ) : (
          <ImageIcon className="size-5" aria-hidden="true" />
        )}
        <span className="sr-only">{alt}</span>
      </div>
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
