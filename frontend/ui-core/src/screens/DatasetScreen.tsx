/**
 * The curation-and-publication tail: the trunk, its releases, and getting the data
 * out.
 *
 * ## A release is the only truly immutable artifact, and the screen says so
 *
 * `docs/releases.md`: the manifest is a **pure function of content** — no
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
 * and the UI keeps them apart too: the delete dialog is #53's, the schema dialog is
 * #53's, and this one is its own.
 *
 * There is no pre-export validation route, so consent is the schema editor's shape:
 * attempt, read `LOSSY_EXPORT_NOT_CONSENTED` off the 409, ask, retry with the flag.
 * `FormatOut.lossy` is what makes the question predictable — it is declared by the
 * *format*, because a bbox-only format loses a polygon whether or not today's
 * dataset holds one.
 *
 * ## Verification is on demand, because it re-reads every blob
 *
 * `ReleaseService.verify` re-reads and re-hashes the lot: `BlobStore.exists` is
 * `is_file()` on a path *named by* the hash and proves nothing. That is not
 * something to do because a list rendered, so the query is `enabled: false` and a
 * button runs it.
 */

import { Check, Download, FileJson, ShieldCheck, Tag, Upload } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import { Alert, Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { BackLink } from "../patterns/BackLink";
import { parentLabel } from "../patterns/parentLabel";
import { saveBlob } from "./download";
import {
  useDatasetStats,
  useDownloadManifest,
  useExportRelease,
  useFormats,
  useProject,
  useProjectDataset,
  usePublishRelease,
  useReleases,
  useVerifyRelease,
  type Release,
} from "./queries";

/** The 409 that means "say you meant it". Not `confirm`, and not destructive. */
const LOSSY = "LOSSY_EXPORT_NOT_CONSENTED";

export interface DatasetScreenProps {
  readonly projectId: string;
  /** Up to the project this trunk belongs to (#199). */
  readonly onBack?: () => void;
}

export function DatasetScreen({ projectId, onBack }: DatasetScreenProps): JSX.Element {
  const project = useProject(projectId);
  const dataset = useProjectDataset(projectId);
  const stats = useDatasetStats(dataset.data?.id);
  const releases = useReleases(dataset.data?.id);
  const [publishing, setPublishing] = useState(false);

  return (
    <div className="flex flex-col gap-6" data-testid="dataset-screen">
      {onBack !== undefined && <BackLink onClick={onBack} label={parentLabel(project.data?.name)} />}

      <header className="flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-page font-semibold tracking-tight">Dataset</h1>
          <p className="text-meta text-muted-foreground">
            The trunk: every asset a completed batch has promoted.
          </p>
        </div>
        <Button
          variant="primary"
          data-testid="publish-release"
          disabled={dataset.data === undefined}
          onClick={() => setPublishing(true)}
        >
          <Tag className="size-4" aria-hidden="true" />
          Publish release
        </Button>
      </header>

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
                  <p className="text-body text-muted-foreground">
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

      <section className="flex flex-col gap-3">
        <h2 className="text-section font-semibold">Releases</h2>
        <Async
          query={releases}
          loadingRows={2}
          empty={{
            title: "No releases yet",
            description:
              "A release freezes the trunk as it is now. Two publishes of an unchanged dataset are byte-identical.",
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
      </section>

      <PublishDialog
        datasetId={dataset.data?.id ?? ""}
        open={publishing}
        onClose={() => setPublishing(false)}
      />
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }): JSX.Element {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-meta text-muted-foreground">{label}</p>
        <p className="text-page font-semibold tabular-nums">{value}</p>
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
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Tag className="size-4 text-muted-foreground" aria-hidden="true" />
          {release.tag}
          <Badge>v{release.schema_version}</Badge>
          {release.split !== null && release.split !== undefined && (
            <Badge variant="accent" data-testid={`split-${release.tag}`}>
              split
            </Badge>
          )}
        </CardTitle>
        <span className="font-mono text-meta text-muted-foreground" title={release.manifest_hash}>
          {release.manifest_hash.slice(0, 12)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-meta text-muted-foreground">
          {release.asset_count} assets · {release.annotation_count} annotations · VisionSet{" "}
          {release.visionset_version} · {release.created_at.slice(0, 19).replace("T", " ")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" data-testid={`export-${release.tag}`} onClick={() => setExporting(true)}>
            <Download className="size-4" aria-hidden="true" />
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
            <FileJson className="size-4" aria-hidden="true" />
            Manifest
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`verify-${release.tag}`}
            disabled={verify.isFetching}
            onClick={() => void verify.refetch()}
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            {verify.isFetching ? "Verifying…" : "Verify"}
          </Button>
        </div>

        {verify.data !== undefined && <Verification report={verify.data} tag={release.tag} />}
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
      <p className="flex items-center gap-2 text-meta text-muted-foreground" data-testid={`verified-${tag}`}>
        <Check className="size-3.5" aria-hidden="true" />
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
          Freezes the trunk as it is now. The manifest is a pure function of content, so
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

          <label className="flex items-center gap-2 text-body">
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
                  <Label htmlFor={`fraction-${fold}`} className="text-meta">
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
                <Label htmlFor="split-seed" className="text-meta">
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
              <p className="col-span-4 text-meta text-muted-foreground" data-testid="split-hint">
                {balanced
                  ? "The split keys on each asset's content hash, so the same seed gives the same folds on every machine."
                  : `Fractions must sum to 1 — they sum to ${sum.toFixed(2)}.`}
              </p>
            </div>
          )}

          {publish.isError && (
            <FieldError data-testid="publish-error">
              {asApiError(publish.error).code}: {asApiError(publish.error).message}
            </FieldError>
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
              <Upload className="size-4" aria-hidden="true" />
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const [format, setFormat] = useState("");
  const [consented, setConsented] = useState(false);

  const installed = formats.data?.items ?? [];
  const chosen = installed.find((one) => one.name === format);
  const failure = exportRelease.isError ? asApiError(exportRelease.error) : null;
  const needsConsent = failure?.code === LOSSY;

  function run(allowLossy: boolean): void {
    exportRelease.mutate(
      { format, ...(allowLossy ? { allowLossy: true } : {}) },
      { onSuccess: (blob) => saveBlob(blob, `${tag}-${format}.zip`) },
    );
  }

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
            {/* Declared by the format, never by the release: a bbox-only format
                loses a polygon whether or not today's dataset holds one. */}
            {chosen?.lossy === true && (
              <FieldHint data-testid="lossy-hint">
                This format cannot express everything the schema allows.
              </FieldHint>
            )}
          </div>

          {needsConsent && (
            <Alert variant="destructive" title={LOSSY} data-testid="lossy-consent">
              <p>{failure?.message}</p>
              <label className="mt-2 flex items-center gap-2 text-body">
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
              {failure.code}: {failure.message}
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
            disabled={format === "" || exportRelease.isPending || (needsConsent && !consented)}
            onClick={() => run(needsConsent)}
          >
            <Download className="size-4" aria-hidden="true" />
            {exportRelease.isPending ? "Exporting…" : needsConsent ? "Export anyway" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
