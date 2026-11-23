/**
 * Two probes for the schema-change hooks, rendered by the schema editor's suite:
 * each calls one hook and prints what it answered.
 */

import { useState, type JSX } from "react";

import {
  usePreviewSchemaChange,
  useSchemaBlockingAssets,
  type LabelClassBody,
  type SchemaChangePreview,
} from "../screens/queries";

export function PreviewSchemaChangeProbe({
  projectId,
  classes,
}: {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[];
}): JSX.Element {
  const preview = usePreviewSchemaChange(projectId);
  const [result, setResult] = useState<SchemaChangePreview | null>(null);

  return (
    <div>
      <button
        data-testid="preview-schema-change"
        disabled={preview.isPending}
        onClick={async () => {
          if (preview.isPending) return;
          setResult(await preview.mutateAsync({ classes }));
        }}
      >
        preview
      </button>
      {result === null ? null : (
        <p data-testid="preview-result">
          {`${result.diff.destructive_classes.join(",")}:${result.blockers[0]?.annotations}:${result.blockers[0]?.assets}:${result.is_refused}`}
        </p>
      )}
    </div>
  );
}

export function SchemaBlockingAssetsProbe({
  projectId,
  classes,
}: {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[] | null;
}): JSX.Element {
  const query = useSchemaBlockingAssets(projectId, classes);
  return (
    <div data-testid="blocking-assets-result">
      {query.data === undefined
        ? "pending"
        : `${query.data.total}:${query.data.items[0]?.annotations}:${query.data.items[0]?.batch_ids.length}`}
    </div>
  );
}
