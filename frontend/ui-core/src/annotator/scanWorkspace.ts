/**
 * The scan editor on the annotation page: the scan's own store beside the image
 * store, the Edit mode, the cuboid tool and its class, and the save plan for the
 * scan's cuboids.
 *
 * Built per asset and rebuilt on `loaded` exactly as the image store is, so a
 * save lands the server's ids and the history starts again. Editing is derived,
 * never mirrored: a scan whose source declares no frame, or a frame that turns
 * read-only under somebody, drops out of Edit on the render that learns it.
 */

import {
  AnnotatorStore,
  documentCommand,
  removeScanAnnotations,
  scanDocumentFromWire,
  scanEditability,
  type LabelClass,
  type ScanAnnotation,
  type ScanDocument,
  type ScanEditability,
  type ScanTool,
  type StoreSnapshot,
} from "@visionset/annotator";
import { useAnnotatorSnapshot, useScanEditor, type ScanEditor } from "@visionset/annotator/react";
import { useCallback, useMemo, useState } from "react";

import { useSource } from "../screens/queries";
import { planScanSave, type SavePlan, type WireAnnotation } from "./jobQueries";

export interface ScanWorkspaceAsset {
  readonly id: string;
  readonly modality: "image" | "point_cloud";
  readonly source_id: string | null;
}

export type ScanToolKind = "select" | "cuboid";

export interface ScanWorkspace {
  readonly store: AnnotatorStore<ScanDocument>;
  readonly snapshot: StoreSnapshot<ScanDocument>;
  readonly editability: ScanEditability;
  /** Whether the source has answered; until then nothing is said about the frame. */
  readonly frameKnown: boolean;
  /** Why Edit cannot be turned on, or `null` when it can. */
  readonly editBlocked: string | null;
  readonly editing: boolean;
  readonly setEditing: (on: boolean) => void;
  readonly toolKind: ScanToolKind;
  readonly setToolKind: (tool: ScanToolKind) => void;
  /** The classes a cuboid may be drawn as: those that declare `cuboid_3d`. */
  readonly cuboidClasses: readonly LabelClass[];
  readonly cuboidClass: string | null;
  readonly setCuboidClass: (labelClass: string) => void;
  /** Why the cuboid tool cannot draw, or `null` when it can. */
  readonly drawBlocked: string | null;
  readonly groundHeight: number;
  readonly setGroundHeight: (height: number) => void;
  readonly editor: ScanEditor;
  readonly plan: SavePlan<ScanAnnotation>;
  /** Delete through the command log, so the panel's delete undoes like the keyboard's. */
  readonly remove: (ids: readonly string[]) => void;
}

const EMPTY_PLAN: SavePlan<ScanAnnotation> = { created: [], updated: [], deleted: [] };

export const FRAME_UNDECLARED_REASON =
  "This scan's source declares no frame, so its labels cannot be edited. Declare the frame on the source to edit them.";
export const READ_ONLY_REASON = "This scan is open for viewing only, so its labels cannot be edited.";
export const NO_CUBOID_CLASS_REASON = "No class in this schema accepts a 3D cuboid.";

export function useScanWorkspace({
  asset,
  schema,
  loaded,
  readOnly,
}: {
  readonly asset: ScanWorkspaceAsset;
  /** The pinned schema as the wire sent it; the store parses it. */
  readonly schema: unknown;
  readonly loaded: readonly WireAnnotation[];
  readonly readOnly: boolean;
}): ScanWorkspace | null {
  const isScan = asset.modality === "point_cloud";
  const store = useMemo(
    () =>
      isScan
        ? new AnnotatorStore<ScanDocument>(
            scanDocumentFromWire({
              asset: { id: asset.id, width: 0, height: 0, modality: "point_cloud" },
              schema,
              annotations: loaded,
            }),
          )
        : null,
    [isScan, asset.id, schema, loaded],
  );
  const snapshot = useAnnotatorSnapshot(store);

  const source = useSource(isScan ? (asset.source_id ?? undefined) : undefined);
  const frameKnown = asset.source_id === null || source.data !== undefined || source.isError;
  const declaredFrame = source.data?.frame;
  const editability = useMemo<ScanEditability>(
    () =>
      store === null
        ? { editable: false, reason: "not-a-scan" }
        : scanEditability(store.document.asset, declaredFrame),
    [store, declaredFrame],
  );

  const editBlocked = readOnly
    ? READ_ONLY_REASON
    : !frameKnown
      ? null
      : editability.editable
        ? null
        : FRAME_UNDECLARED_REASON;
  const [wantsEditing, setEditing] = useState(false);
  const editing = wantsEditing && editBlocked === null && frameKnown && editability.editable;

  const cuboidClasses = useMemo(
    () => (store === null ? [] : store.document.schema.classes.filter((declared) => declared.geometries.includes("cuboid_3d"))),
    [store],
  );
  const [pickedClass, setCuboidClass] = useState<string | null>(null);
  const cuboidClass =
    pickedClass !== null && cuboidClasses.some((one) => one.name === pickedClass)
      ? pickedClass
      : (cuboidClasses[0]?.name ?? null);
  const drawBlocked = cuboidClass === null ? NO_CUBOID_CLASS_REASON : null;
  const [pickedTool, setToolKind] = useState<ScanToolKind>("select");
  const toolKind: ScanToolKind = drawBlocked === null ? pickedTool : "select";
  const tool = useMemo<ScanTool>(
    () => (toolKind === "cuboid" && cuboidClass !== null ? { kind: "cuboid", labelClass: cuboidClass } : { kind: "select" }),
    [toolKind, cuboidClass],
  );

  const [groundHeight, setGroundHeight] = useState(0);
  const editor = useScanEditor({
    store,
    frame: editability.editable ? editability.frame : null,
    groundHeight,
    tool,
    enabled: editing,
  });

  const plan = useMemo(
    () => (snapshot === null ? EMPTY_PLAN : planScanSave(snapshot.document, loaded)),
    [snapshot, loaded],
  );

  const remove = useCallback(
    (ids: readonly string[]): void => {
      if (store === null) return;
      const present = ids.filter((id) => store.document.annotations.has(id));
      if (present.length === 0) return;
      store.execute(documentCommand<ScanDocument>("delete", (document) => removeScanAnnotations(document, present)));
    },
    [store],
  );

  if (store === null || snapshot === null) return null;
  return {
    store,
    snapshot,
    editability,
    frameKnown,
    editBlocked,
    editing,
    setEditing,
    toolKind,
    setToolKind,
    cuboidClasses,
    cuboidClass,
    setCuboidClass,
    drawBlocked,
    groundHeight,
    setGroundHeight,
    editor,
    plan,
    remove,
  };
}
