/**
 * The asset's own pixels, fetched with the credential.
 *
 * The same problem `AssetThumbnail` has and the same answer: every route but
 * `/health` authenticates with `Authorization: Bearer`, and an `<img src>` sends no
 * header — the browser issues that request itself. So the bytes are fetched through
 * the typed client and handed over as an object URL, which is revoked when the
 * asset changes.
 *
 * It is a render prop rather than an `<img>`, because the consumer is
 * `AnnotatorCanvas` and the canvas takes a **`imageSrc` string**: the picture is
 * laid out at the *descriptor's* size, never at its natural one, which is
 * `get_asset_image`'s finding one layer out. Handing the canvas a URL keeps that
 * rule where it already lives.
 *
 * Unlike a thumbnail there is no NULL case: an asset always has content. A failure
 * here is a real failure, and it says so rather than degrading to a placeholder.
 */

import { ImageOff } from "lucide-react";
import { useEffect, useState, type JSX, type ReactNode } from "react";

import { useApiClient } from "../data/ApiProvider";

export interface AssetImageProps {
  readonly projectId: string;
  readonly assetId: string;
  readonly children: (src: string) => ReactNode;
}

export function AssetImage({ projectId, assetId, children }: AssetImageProps): JSX.Element {
  const client = useApiClient();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setSrc(null);
    setFailed(false);

    void (async () => {
      const result = await client.GET("/projects/{project_id}/assets/{asset_id}/content", {
        params: { path: { project_id: projectId, asset_id: assetId } },
        // The route answers image bytes; without this `openapi-fetch` parses JSON
        // and every asset fails on a syntax error.
        parseAs: "blob",
      });
      if (!live) return;
      if (result.error !== undefined || result.data === undefined) {
        setFailed(true);
        return;
      }
      objectUrl = URL.createObjectURL(result.data as unknown as Blob);
      setSrc(objectUrl);
    })();

    return () => {
      live = false;
      // Every `createObjectURL` pins its blob until this runs, and an annotator
      // walking a fifty-asset job would otherwise hold fifty full-size images.
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [client, projectId, assetId]);

  if (failed) {
    return (
      <div
        data-testid="asset-image-error"
        className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground"
      >
        <ImageOff className="size-6" aria-hidden="true" />
        <span className="text-meta">The asset&rsquo;s content could not be loaded.</span>
      </div>
    );
  }

  if (src === null) {
    return <div data-testid="asset-image-loading" className="size-full animate-pulse bg-muted/10" />;
  }

  return <>{children(src)}</>;
}
