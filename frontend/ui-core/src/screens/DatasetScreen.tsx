/**
 * The curation-and-publication tail: the trunk, its releases, and getting the data
 * out.
 *
 * ## A release is the only truly immutable artifact, and the screen says so
 *
 * `docs/content/releases.md`: the manifest is a **pure function of content** — no
 * timestamp, no tag, no release id inside the document — which is what makes two
 * publishes of an unchanged dataset byte-identical and share one blob. So the
 * timeline never offers an edit or a delete: there is no `ReleaseService.delete`,
 * and only a project's own cascade removes one.
 *
 * ## Three gate words, and this screen is where the third one lives
 *
 * `confirm=` guards destroying data, `allow_destructive=` guards narrowing a
 * contract, and **`allow_lossy=` guards emitting an incomplete copy** of something
 * that stays intact. The kernel is emphatic that they are never caught together,
 * and the UI keeps them apart too: the delete dialog, the schema dialog and this
 * one are three.
 *
 * There is no pre-export validation route, so consent here is attempt-shaped:
 * attempt, read `LOSSY_EXPORT_NOT_CONSENTED` off the 409, ask, retry with the flag.
 * The schema editor does not have this shape — it previews first — and the
 * difference is exactly the routed preview that export lacks.
 * `FormatOut.lossy` is what makes the question predictable — it is declared by the
 * *format*, because a bbox-only format loses a polygon whether or not today's
 * dataset holds one.
 *
 * ## The trunk's membership is on the screen now, and so is curation
 *
 * `DELETE /datasets/{id}/assets/{id}` is the API's only curation operation, and it
 * cannot simply be added to a listing, because this screen shows
 * the counts and not the membership those counts are *of*. `TrunkAssets` below
 * is both halves. Removal is curation and not deletion, which is why
 * `DatasetService.remove_asset` is one of exactly two service methods with no
 * `confirm=` gate — see `RemoveAssetDialog` for what that means for the copy.
 *
 * ## Verification is on demand, because it re-reads every blob
 *
 * `ReleaseService.verify` re-reads and re-hashes the lot: `BlobStore.exists` is
 * `is_file()` on a path *named by* the hash and proves nothing. That is not
 * something to do because a list rendered, so the query is `enabled: false` and a
 * button runs it.
 */

import {
  IconCheck,
  IconDownload,
  IconJson,
  IconShieldCheck,
  IconTag,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useEffect, useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import { Alert, Badge } from "../primitives/Badge";
import type { BadgeTone } from "./batchState";
import { SectionHeader } from "../patterns/SectionHeader";
import { Button } from "../primitives/Button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../primitives/Card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/Tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import {
  classBlockers,
  describeClassCount,
  jobFailureProse,
  lostClasses,
  refusalProse,
} from "../data/refusals";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { EmptyState, ErrorState } from "../patterns/AsyncStates";
import { AssetThumbnail } from "./AssetThumbnail";
import { DatasetAssetDialog, trunkAssetLabel } from "./DatasetAssetDialog";
import { saveBlob } from "./download";
import {
  TRUNK_PAGE_SIZE,
  useBackgroundJob,
  useDatasetAssets,
  useDatasetStats,
  useDownloadManifest,
  useExportRelease,
  useFormats,
  useJobArtifact,
  useProjectDataset,
  usePublishRelease,
  useReleases,
  useRemoveDatasetAsset,
  useVerifyRelease,
  type DatasetAsset,
  type BackgroundJob,
  type Release,
} from "./queries";

/** The 409 that means "say you meant it". Not `confirm`, and not destructive. */
const LOSSY = "LOSSY_EXPORT_NOT_CONSENTED";
/** The 409 that names classes: the active schema no longer describes some of the trunk. */
const CONTENT_VIOLATES_SCHEMA = "RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA";

/*
 * There is no `onBack` any more, and no way out of its own.
 *
 * The trunk is a project **section**, so its way out is the navigation and the crumbs
 * above it belong to the project page this renders inside — a second answer to
 * "where am I", one panel further in, would contradict the first. The prop
 * survived the move to a tab with no caller passing it, which is the dead
 * flexibility the `information-architecture` rule exists to prevent. Its old
 * route is a redirect, so nothing can reach this screen standalone.
 */
/**
 * The dataset's three views: what it holds in numbers, what it holds in pictures,
 * what has been frozen out of it. Tabs, because each answers a different question
 * and the page was all three at once — counts, a grid and a timeline in one
 * column, each pushing the next below the fold.
 */
export type DatasetTab = "overview" | "assets" | "releases";

const DATASET_TABS: readonly DatasetTab[] = ["overview", "assets", "releases"];
const DEFAULT_DATASET_TAB: DatasetTab = "overview";

export interface DatasetScreenProps {
  readonly projectId: string;
  /** Which view to open on. Absent or unrecognised opens on Overview. */
  readonly tab?: string;
  /** Absent means uncontrolled: the tabs work, they just do not reach a URL. */
  readonly onTabChange?: (tab: DatasetTab) => void;
}

export function DatasetScreen({ projectId, tab, onTabChange }: DatasetScreenProps): JSX.Element {
  const dataset = useProjectDataset(projectId);
  const stats = useDatasetStats(dataset.data?.id);
  const releases = useReleases(dataset.data?.id);
  const [publishing, setPublishing] = useState(false);
  const current = DATASET_TABS.find((one) => one === tab) ?? DEFAULT_DATASET_TAB;

  return (
    <div className="flex flex-col gap-6" data-testid="dataset-screen">
      <SectionHeader
        title="Dataset"
        meta="Every asset a completed batch has promoted."
        actions={
          // `secondary`: the project's navigation holds the page's filled
          // action. One filled action per view.
          <Button
            variant="secondary"
            data-testid="publish-release"
            disabled={dataset.data === undefined}
            onClick={() => setPublishing(true)}
          >
            <IconTag className="size-4" aria-hidden="true" />
            Publish release
          </Button>
        }
      />

      <Tabs
        // Controlled by the host when it wired one, uncontrolled otherwise — and
        // `current` seeds the uncontrolled case too, so `tab` alone still says
        // which view to open on.
        {...(onTabChange === undefined
          ? { defaultValue: current }
          : {
              value: current,
              onValueChange: (next: string) =>
                onTabChange(DATASET_TABS.find((one) => one === next) ?? DEFAULT_DATASET_TAB),
            })}
        data-testid="dataset-tabs"
      >
        {/* The product's one tab shape — a row on a full-width hairline, the
            active tab's rule sitting on it — with the count as a chip beside the
            two views whose size is the first thing anybody asks. */}
        <TabsList variant="line">
          <TabsTrigger value="overview" data-testid="dataset-tab-overview">
            Overview
          </TabsTrigger>
          <TabsTrigger value="assets" data-testid="dataset-tab-assets">
            Assets
            {stats.data !== undefined && <Badge>{stats.data.asset_count}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="releases" data-testid="dataset-tab-releases">
            Releases
            {releases.data !== undefined && <Badge>{releases.data.total}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
        <Async query={stats} loadingRows={3}>
          {(counts) => (
            <div className="flex flex-col gap-4" data-testid="dataset-stats">
              <div className="grid gap-4 md:grid-cols-3">
                <Stat label="Assets" value={counts.asset_count} />
                <Stat label="With annotations" value={counts.annotated_asset_count} />
                <Stat label="Annotations" value={counts.annotation_count} />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Per class</CardTitle>
                </CardHeader>
                <CardContent>
                  {counts.classes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing labelled yet. A class the schema declares but nobody used does
                      not appear here — which classes exist is the schema&rsquo;s answer.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Class</TableHead>
                          <TableHead className="w-32">Annotations</TableHead>
                          <TableHead className="w-32">Assets</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {counts.classes.map((row) => (
                          <TableRow key={row.label_class} data-testid={`class-count-${row.label_class}`}>
                            <TableCell>{row.label_class}</TableCell>
                            {/* Both, because a thousand labels over a thousand images
                                and the same thousand over ten are the same total and a
                                very different dataset. */}
                            <TableCell>{row.annotations}</TableCell>
                            <TableCell>{row.assets}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </Async>
        </TabsContent>

        <TabsContent value="assets">
          <TrunkAssets projectId={projectId} datasetId={dataset.data?.id} />
        </TabsContent>

        <TabsContent value="releases">
          <Async
            query={releases}
            loadingRows={2}
            empty={{
              title: "No releases yet",
              description:
                "A release freezes the dataset as it is now. Publishing twice with nothing changed in between produces byte-identical documents.",
            }}
          >
            {(page) => (
              <div className="flex flex-col gap-3" data-testid="release-timeline">
                {[...page.items]
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
                  .map((release) => (
                    <ReleaseCard key={release.id} release={release} />
                  ))}
              </div>
            )}
          </Async>
        </TabsContent>
      </Tabs>

      <PublishDialog
        datasetId={dataset.data?.id ?? ""}
        open={publishing}
        onClose={() => setPublishing(false)}
      />
    </div>
  );
}

/**
 * What is in the trunk, and the one way to take something out of it.
 *
 * ## Why there is a listing here at all
 *
 * `DELETE /datasets/{id}/assets/{id}` has been on the wire since M3 and no screen
 * called it — the API's only curation operation over the trunk, unreachable from
 * the product. It could not be added to a listing, because there was no listing:
 * this screen showed counts and releases and never the membership those counts
 * are *of*. So the control needed a tile to hang on, and this is that tile — and
 * once there was a tile, there was something to open: the preview beside it.
 *
 * ## Paged, because the trunk is the one collection that only grows
 *
 * Every completed batch a project ever promoted accumulates here. `docs/content/api.md`
 * is explicit that `limit`/`offset` bound the **response, not the read**, so
 * `total` stays the size of the whole trunk and the control pages until it has
 * seen that many — never until the number stops moving.
 *
 * ## No capability gate, and that is a decision rather than an omission
 *
 * `DatasetAssetOut` declares no `allowed_actions`, and the route is unconditional: it
 * answers 204 whether or not the asset was a member, refuses nothing about the
 * asset's state, and the kernel gives it no `confirm=` gate. Writing a
 * `canRemove(asset)` here would be the hand-mirrored table the `ui-capabilities`
 * skill bans, inventing a rule the wire does not have. If removal ever *does*
 * become conditional, the fix is a declaration on the wire, not a helper here.
 */
function TrunkAssets({
  projectId,
  datasetId,
}: {
  readonly projectId: string;
  readonly datasetId: string | undefined;
}): JSX.Element {
  const [offset, setOffset] = useState(0);
  const page = useDatasetAssets(datasetId, offset);
  const [removing, setRemoving] = useState<DatasetAsset | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const total = page.data?.total ?? 0;
  const items = page.data?.items ?? [];

  return (
    <section className="flex flex-col gap-3" data-testid="trunk-assets">
      <div className="flex flex-wrap items-end justify-between gap-2">
        {/* The tab is the heading. What is left is the sentence it cannot carry. */}
        <p className="text-xs text-muted-foreground">
          Every asset a completed batch has promoted, in the order they were promoted. Open one to
          see its labels.
        </p>
        {total > TRUNK_PAGE_SIZE && (
          <div className="flex items-center gap-2" data-testid="trunk-paging">
            <span className="text-xs tabular-nums text-muted-foreground">
              {offset + 1}&ndash;{Math.min(offset + TRUNK_PAGE_SIZE, total)} of {total}
            </span>
            <Button
              variant="secondary"
              size="sm"
              data-testid="trunk-previous"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - TRUNK_PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="trunk-next"
              disabled={offset + TRUNK_PAGE_SIZE >= total}
              onClick={() => setOffset(offset + TRUNK_PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      <Async
        query={page}
        loadingRows={3}
        empty={{
          title: "Nothing promoted yet",
          description:
            "Completing a batch and promoting it puts its assets here. Until then the dataset is empty.",
        }}
      >
        {(assets) => (
          <div
            data-testid="trunk-grid"
            className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]"
          >
            {assets.items.map((asset, index) => (
              <TrunkTile
                key={asset.id}
                projectId={projectId}
                asset={asset}
                onOpen={() => setViewing(index)}
                onRemove={() => setRemoving(asset)}
              />
            ))}
          </div>
        )}
      </Async>

      {viewing !== null && datasetId !== undefined && (
        <DatasetAssetDialog
          projectId={projectId}
          datasetId={datasetId}
          assets={items}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          onRemove={setRemoving}
        />
      )}

      {removing !== null && datasetId !== undefined && (
        <RemoveAssetDialog
          datasetId={datasetId}
          asset={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            // The viewer was looking at a page that no longer has this member,
            // and the index it held now names the next one over — closing is
            // the honest answer rather than silently showing a neighbour.
            setViewing(null);
            // The page this tile was on may no longer exist: removing the only
            // member of the last page leaves an offset past the end, which the
            // API answers 200-and-empty rather than 404. Stepping back is the
            // honest place to land.
            if (offset > 0 && items.length === 1) {
              setOffset(Math.max(0, offset - TRUNK_PAGE_SIZE));
            }
          }}
        />
      )}
    </section>
  );
}

/**
 * One member as a tile: the picture, the frame number over it, and how many
 * labels it carries. The caption's word is "labels" and not the batch tile's
 * "boxes", because the trunk holds every geometry a schema allows and the count
 * is read off `annotation_count`, which does not say which.
 */
function TrunkTile({
  projectId,
  asset,
  onOpen,
  onRemove,
}: {
  readonly projectId: string;
  readonly asset: DatasetAsset;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const label = trunkAssetLabel(asset);
  const pill =
    asset.frame_index == null ? asset.content_hash.slice(0, 8) : String(asset.frame_index);
  const count = asset.annotation_count;
  const word = count === 0 ? "No labels" : `${count} ${count === 1 ? "label" : "labels"}`;

  return (
    <div data-testid={`trunk-asset-${asset.id}`} className="flex flex-col gap-1">
      <button
        type="button"
        data-testid={`open-${asset.id}`}
        aria-label={`Preview ${label}`}
        onClick={onOpen}
        className={
          "relative aspect-[4/3] w-full overflow-hidden rounded-md border border-border bg-card p-0 " +
          "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        }
      >
        <AssetThumbnail
          projectId={projectId}
          assetId={asset.id}
          thumbnailHash={asset.thumbnail_hash}
          alt={label}
          className="size-full object-cover"
        />
        <span className="absolute left-1 top-1 rounded-sm bg-card/90 px-1 font-mono text-xs text-foreground">
          {pill}
        </span>
      </button>
      <span className="flex items-center justify-between gap-1 px-0.5">
        <span
          data-testid={`labels-${asset.id}`}
          className="truncate text-xs text-muted-foreground"
          {...(asset.label_classes.length === 0 ? {} : { title: asset.label_classes.join(", ") })}
        >
          {word}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid={`remove-${asset.id}`}
          aria-label={`Remove ${label} from the dataset`}
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive"
        >
          <IconTrash aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}

/**
 * Curation, and a confirmation that says what it actually costs.
 *
 * `DESIGN.md`: a confirmation names what will happen. Here the useful half of
 * that is mostly what will **not** happen, and every clause below was read off
 * `DatasetService.remove_asset` rather than assumed:
 *
 * - the asset, its annotations and its bytes all stay — content is hash-addressed
 *   and shared, so no dataset can know it is the last owner, and `BlobStore` has
 *   no `delete` at all;
 * - **a release that already names the asset is untouched**, because a release is
 *   a snapshot and curating the trunk afterwards does not reach back into it;
 * - promotion is a *union* with no memory of removals, so re-promoting the batch
 *   the asset came from puts it back.
 *
 * Which is exactly why the kernel gives this no `confirm=` gate — it is one of
 * only two service methods without one. The dialog is here because taking an
 * asset out of a release-bound dataset is still a decision, not because the
 * kernel demands consent for it, and the copy has to be honest about that
 * difference or it teaches the wrong thing about what removal means.
 */
function RemoveAssetDialog({
  datasetId,
  asset,
  onClose,
  onRemoved,
}: {
  readonly datasetId: string;
  readonly asset: DatasetAsset;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}): JSX.Element {
  const remove = useRemoveDatasetAsset(datasetId);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="remove-asset-dialog">
        <DialogTitle>Remove {trunkAssetLabel(asset)} from the dataset?</DialogTitle>
        <DialogDescription data-testid="remove-asset-consequence">
          This removes the image from the dataset, together with its annotations. The image itself
          is not deleted: the file, its annotations and its stored data remain in the project, and
          any release already published is unaffected. Promoting the batch again will restore it to
          the dataset.
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="remove-asset-error">{refusalProse(remove.error)}</FieldError>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="remove-asset-submit"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(asset.id, {
                onSuccess: () => {
                  onRemoved();
                  onClose();
                },
              })
            }
          >
            {remove.isPending ? "Removing…" : "Remove from dataset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }): JSX.Element {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function ReleaseCard({ release }: { readonly release: Release }): JSX.Element {
  const verify = useVerifyRelease(release.id);
  const manifest = useDownloadManifest(release.id);
  const [exporting, setExporting] = useState(false);

  return (
    <Card data-testid={`release-${release.tag}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconTag className="size-4 text-muted-foreground" aria-hidden="true" />
          {release.tag}
          <Badge>v{release.schema_version}</Badge>
          {release.split !== null && release.split !== undefined && (
            <Badge variant="accent" data-testid={`split-${release.tag}`}>
              split
            </Badge>
          )}
        </CardTitle>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground" title={release.manifest_hash}>
            {release.manifest_hash.slice(0, 12)}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {release.asset_count} assets · {release.annotation_count} annotations · VisionSet{" "}
          {release.visionset_version} · {release.created_at.slice(0, 19).replace("T", " ")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" data-testid={`export-${release.tag}`} onClick={() => setExporting(true)}>
            <IconDownload className="size-4" aria-hidden="true" />
            Export
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid={`manifest-${release.tag}`}
            disabled={manifest.isPending}
            onClick={() =>
              manifest.mutate(undefined, {
                onSuccess: (blob) => saveBlob(blob, `${release.tag}-manifest.json`),
              })
            }
          >
            <IconJson className="size-4" aria-hidden="true" />
            Manifest
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`verify-${release.tag}`}
            disabled={verify.isFetching}
            onClick={() => void verify.refetch()}
          >
            <IconShieldCheck className="size-4" aria-hidden="true" />
            {verify.isFetching ? "Verifying…" : "Verify"}
          </Button>
        </div>

        {/*
          The download that said nothing at all when it failed (audit F8).
          `manifest.isError` was read nowhere, so a refusal produced no file and
          no message — indistinguishable from a browser that had swallowed the
          save dialog, which is the one explanation a user would reach for.
        */}
        {manifest.isError && (
          <FieldError data-testid={`manifest-error-${release.tag}`}>
            {refusalProse(manifest.error)}
          </FieldError>
        )}

        {/*
          A verify that could not be *asked* is not a verification that found
          something (audit F10). Only the report had a rendering, so a failed
          request left the button un-pressed-looking and the last report, if any,
          still on screen underneath — the worst possible answer, since a stale
          "everything checks out" is exactly what somebody presses Verify to stop
          trusting.
        */}
        {verify.isError && (
          <FieldError data-testid={`verify-error-${release.tag}`}>
            {refusalProse(verify.error)}
          </FieldError>
        )}

        {verify.data !== undefined && !verify.isError && (
          <Verification report={verify.data} tag={release.tag} />
        )}
      </CardContent>

      <ExportDialog releaseId={release.id} tag={release.tag} open={exporting} onClose={() => setExporting(false)} />
    </Card>
  );
}

/**
 * What `verify` found.
 *
 * `manifest_intact: false` is reported first and on its own: when the manifest's
 * own bytes fail its hash the service stops with `checked: 0`, so every other
 * number is about nothing. `cache_mismatches` is its own line too — the release
 * row's counts are an explicit read cache over the manifest, and the two
 * disagreeing is a different problem from a blob being gone.
 */
function Verification({
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
      <Alert variant="destructive" title="The manifest itself does not match its hash" data-testid={`verified-${tag}`}>
        Nothing else could be checked — every count in this release is derived from a
        document that is not the one its hash names.
      </Alert>
    );
  }
  if (report.ok) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`verified-${tag}`}>
        <IconCheck className="size-3.5" aria-hidden="true" />
        {report.checked} blobs re-read and re-hashed. Intact.
      </p>
    );
  }
  return (
    <Alert variant="destructive" title="This release cannot be reproduced" data-testid={`verified-${tag}`}>
      {report.missing.length} missing · {report.corrupt.length} corrupt ·{" "}
      {report.cache_mismatches.length} cache mismatch
      {report.cache_mismatches.length === 1 ? "" : "es"} of {report.checked} checked.
    </Alert>
  );
}

function PublishDialog({
  datasetId,
  open,
  onClose,
}: {
  readonly datasetId: string;
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const publish = usePublishRelease(datasetId);
  const [tag, setTag] = useState("");
  const [split, setSplit] = useState(false);
  const [fractions, setFractions] = useState({ train: "0.7", val: "0.15", test: "0.15" });
  const [seed, setSeed] = useState("0");

  const sum = Number(fractions.train) + Number(fractions.val) + Number(fractions.test);
  // The kernel compares with `math.isclose(..., abs_tol=1e-9)` because
  // `0.7 + 0.15 + 0.15 != 1.0` in binary floating point. Mirrored rather than
  // restated: a stricter check here would refuse a recipe the API accepts.
  const balanced = Math.abs(sum - 1) < 1e-9;
  const failure = publish.isError ? asApiError(publish.error) : null;
  const blockers =
    failure?.code === CONTENT_VIOLATES_SCHEMA ? classBlockers(failure.detail) : null;

  function submit(event: FormEvent): void {
    event.preventDefault();
    publish.mutate(
      {
        tag: tag.trim(),
        ...(split
          ? {
              split: {
                train: Number(fractions.train),
                val: Number(fractions.val),
                test: Number(fractions.test),
                seed: Number(seed),
              },
            }
          : {}),
      },
      {
        onSuccess: () => {
          setTag("");
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="publish-dialog">
        <DialogTitle>Publish a release</DialogTitle>
        <DialogDescription>
          Freezes the dataset as it is now. The manifest is a pure function of content, so
          publishing an unchanged dataset twice produces byte-identical documents.
        </DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="release-tag">Tag</Label>
            <Input
              id="release-tag"
              data-testid="release-tag"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              placeholder="v1"
              autoFocus
            />
            {/* The opposite of a project name, which is unique case-insensitively.
                Two rules, each beside its own index. */}
            <FieldHint>Unique per dataset, and case-sensitive.</FieldHint>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              data-testid="use-split"
              checked={split}
              onChange={(event) => setSplit(event.target.checked)}
            />
            Assign train / val / test folds
          </label>

          {split && (
            <div className="grid grid-cols-4 gap-2">
              {(["train", "val", "test"] as const).map((fold) => (
                <div key={fold} className="flex flex-col gap-1">
                  <Label htmlFor={`fraction-${fold}`} className="text-xs">
                    {fold}
                  </Label>
                  <Input
                    id={`fraction-${fold}`}
                    data-testid={`fraction-${fold}`}
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={fractions[fold]}
                    onChange={(event) =>
                      setFractions((current) => ({ ...current, [fold]: event.target.value }))
                    }
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1">
                <Label htmlFor="split-seed" className="text-xs">
                  seed
                </Label>
                <Input
                  id="split-seed"
                  data-testid="split-seed"
                  type="number"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </div>
              <p className="col-span-4 text-xs text-muted-foreground" data-testid="split-hint">
                {balanced
                  ? "The split keys on each asset's content hash, so the same seed gives the same folds on every machine."
                  : `Fractions must sum to 1 — they sum to ${sum.toFixed(2)}.`}
              </p>
            </div>
          )}

          {publish.isError && (
            <FieldError data-testid="publish-error">
              {refusalProse(publish.error)}
            </FieldError>
          )}
          {blockers !== null && (
            <div className="flex flex-col gap-1 text-sm" data-testid="publish-blockers">
              <ul className="list-disc pl-5">
                {blockers.map((blocker) => (
                  <li key={blocker.label_class}>{describeClassCount(blocker)}</li>
                ))}
              </ul>
              <p className="text-muted-foreground" data-testid="publish-remedy">
                Correct those labels in a new batch, remove the frames from the dataset, or
                publish a schema version that describes the classes again — then publish.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="publish-submit"
              disabled={tag.trim() === "" || publish.isPending || (split && !balanced)}
            >
              <IconUpload className="size-4" aria-hidden="true" />
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Whether a job will not change again. The client half of `SETTLED_JOB_STATES`. */
function isSettled(job: BackgroundJob): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
}

/**
 * `BackgroundJobState`, in a person's words and in a token.
 *
 * Without a rendering these five states are **only a polling predicate** —
 * `isSettled` above — so the one genuinely long-running operation in this product
 * answers "how is it going?" with a button label and nothing else, and "did it
 * work?" with a download that either happens or does not.
 *
 * `cancelled` is **neutral, not `destructive`**: somebody asked for it. It is the
 * same call `skipped` gets one file over — a decision is not an error.
 */
const JOB_STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Exporting",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const JOB_STATE_VARIANT: Record<string, BadgeTone> = {
  queued: "neutral",
  running: "accent",
  succeeded: "success",
  failed: "destructive",
  cancelled: "neutral",
};


function ExportDialog({
  releaseId,
  tag,
  open,
  onClose,
}: {
  readonly releaseId: string;
  readonly tag: string;
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const formats = useFormats();
  const exportRelease = useExportRelease(releaseId);
  const artifact = useJobArtifact();
  const [format, setFormat] = useState("");
  const [consented, setConsented] = useState(false);
  // The job this dialog is watching. Null until a launch is accepted, and null
  // again once the archive has been saved — a finished download is not something
  // to keep polling.
  const [jobId, setJobId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The last state this dialog saw, held because a succeeded job clears `jobId`
  // the moment its archive is saved — so the badge would announce the outcome
  // and remove it in the same tick. Cleared by `run`, not by the poll.
  const [outcome, setOutcome] = useState<string | null>(null);
  const job = useBackgroundJob(jobId);

  const installed = formats.data?.items ?? [];
  const chosen = installed.find((one) => one.name === format);
  // **The refusals still arrive on the launch.** An unknown format is a 404 and a
  // lossy format without consent is a 409, both answered by the request rather
  // than by the job — so the consent flow below is exactly the one that shipped
  // before export was queued.
  const failure = exportRelease.isError ? asApiError(exportRelease.error) : null;
  const needsConsent = failure?.code === LOSSY;
  const lost = failure !== null && needsConsent ? lostClasses(failure.detail) : null;
  const running = exportRelease.isPending || (job.data !== undefined && !isSettled(job.data));
  const stopped =
    job.data !== undefined && job.data.state !== "succeeded" ? job.data : null;

  function run(allowLossy: boolean): void {
    setSaved(false);
    setOutcome(null);
    exportRelease.mutate(
      { format, ...(allowLossy ? { allowLossy: true } : {}) },
      { onSuccess: (queued) => setJobId(queued.id) },
    );
  }

  // The download, once and only once the work has succeeded.
  //
  // An effect rather than a `usePollingQuery` callback because the *transition*
  // is what matters: the poll answers `succeeded` on every subsequent tick too,
  // and a browser asked to save the same archive four times does it four times.
  // `saved` is the guard, and it is state rather than a ref because a ref-guarded
  // effect under `<StrictMode>` loses the very error it was guarding.
  useEffect(() => {
    if (saved || jobId === null || job.data?.state !== "succeeded") return;
    setSaved(true);
    setOutcome("succeeded");
    artifact.mutate(jobId, {
      onSuccess: (blob) => {
        saveBlob(blob, `${tag}-${format}.zip`);
        setJobId(null);
      },
    });
  }, [saved, jobId, job.data?.state, artifact, tag, format]);

  // The badge's subject: the live job while there is one, the outcome once the
  // archive has been handed over and the poll has stopped.
  const shownState = job.data?.state ?? outcome;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="export-dialog">
        <DialogTitle>Export {tag}</DialogTitle>
        <DialogDescription>
          Writes the release through an installed exporter and downloads the result.
        </DialogDescription>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="export-format">Format</Label>
            {/*
              Three renderings for three answers, because `?? []` above used to
              give the first two the same one — the swallowed-refusal pattern.
              A failed `GET /formats` is not an answer at all; a
              successful empty page is an answer about this server's plugins;
              and the combobox is for when there is something to choose. Rolling
              the first two together produces a control offering nothing and
              saying nothing, which is also the visible signature of an install
              whose exporters are not discoverable — so the screen that should
              tell a broken install from a broken request is what makes the two
              indistinguishable.

              Loading is deliberately not a fourth branch: `formats.data ===
              undefined` while pending, so the combobox stands empty for the one
              tick it takes, exactly as it did before.
            */}
            {formats.isError ? (
              <div data-testid="export-formats-error">
                {/* No `code`: the identifier is not the half a person can act
                    on, and the sibling refusal on this screen
                    (`manifest-error-*`) already renders prose without one. */}
                <ErrorState
                  message={`${refusalProse(formats.error)} Try again to choose a format.`}
                  onRetry={() => void formats.refetch()}
                />
              </div>
            ) : formats.data !== undefined && installed.length === 0 ? (
              <div data-testid="export-formats-empty">
                <EmptyState
                  title="No exporters installed"
                  description="Exporters ship as plugins on the server. Install one to write this release out."
                />
              </div>
            ) : (
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger id="export-format" data-testid="export-format">
                  <SelectValue placeholder="Choose a format" />
                </SelectTrigger>
                <SelectContent>
                  {installed.map((one) => (
                    <SelectItem key={one.name} value={one.name}>
                      {one.name}
                      {one.lossy ? " (lossy)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* Declared by the format, never by the release: a bbox-only format
                loses a polygon whether or not today's dataset holds one. */}
            {chosen?.lossy === true && (
              <FieldHint data-testid="lossy-hint">
                This format cannot express everything the schema allows.
              </FieldHint>
            )}
          </div>

          {/* The status itself. The word is
              on the badge rather than only in its colour, and the sentences
              below stay: a badge is the glance, prose is the answer. */}
          {shownState !== null && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={JOB_STATE_VARIANT[shownState] ?? "neutral"} data-testid="export-job-state">
                {JOB_STATE_LABEL[shownState] ?? shownState}
              </Badge>
              {job.data?.total !== null && job.data?.total !== undefined && (
                <span>
                  {job.data.processed} of {job.data.total}
                </span>
              )}
            </p>
          )}

          {needsConsent && (
            <Alert
              variant="destructive"
              title="Some shapes cannot be exported"
              data-testid="lossy-consent"
            >
              <p>{refusalProse(failure)}</p>
              {lost !== null && lost.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-sm" data-testid="lossy-classes">
                  {lost.map((one) => (
                    <li key={one.label_class}>
                      {describeClassCount(one)}
                      {one.reason != null && (
                        <span className="text-muted-foreground"> {one.reason}.</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary"
                  data-testid="lossy-checkbox"
                  checked={consented}
                  onChange={(event) => setConsented(event.target.checked)}
                />
                Export anyway, accepting that the copy is incomplete.
              </label>
            </Alert>
          )}

          {failure !== null && !needsConsent && (
            <FieldError data-testid="export-error">
              {refusalProse(failure)}
            </FieldError>
          )}

          {/* A job that stopped without producing anything: the only account of
              a failure that happened after the request had already been answered. */}
          {stopped !== null && (
            <FieldError data-testid="export-job-error">
              {stopped.state === "cancelled"
                ? "The export was cancelled."
                : jobFailureProse(stopped, "The export stopped without saying why.")}
            </FieldError>
          )}

          {artifact.isError && (
            <FieldError data-testid="export-download-error">
              {refusalProse(asApiError(artifact.error))}
            </FieldError>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="export-submit"
            // The consent gate: while the API is asking, the button stays shut until
            // the box is ticked. It is `allow_lossy` and never `confirm`.
            disabled={format === "" || running || (needsConsent && !consented)}
            onClick={() => run(needsConsent)}
          >
            <IconDownload className="size-4" aria-hidden="true" />
            {running ? "Exporting…" : needsConsent ? "Export anyway" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
