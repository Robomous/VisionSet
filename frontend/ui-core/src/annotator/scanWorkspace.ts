/**
 * The scan editor on the annotation page: the scan's own store beside the image
 * store, the Edit mode, the cuboid and polyline tools and their classes, and the
 * save plan for the scan's 3D labels.
 *
 * On the annotation page the store is the frame's (`FrameSession`), built once
 * and kept across autosaves, and the plan is read against the session's record
 * of the server and the ids it minted. Without a session — a test, a host with
 * no autosave — the hook builds its own store per asset and rebuilds it on
 * `loaded`, so a save lands the server's ids and the history starts again. Editing is derived,
 * never mirrored: a scan whose source declares no frame, or a frame that turns
 * read-only under somebody, drops out of Edit on the render that learns it.
 */

import {
  AnnotatorStore,
  documentCommand,
  removeScanAnnotations,
  scanDocumentFromWire,
  scanEditability,
  type GeometryType,
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

export type ScanToolKind = "select" | "cuboid" | "polyline";
export type ScanDrawKind = Exclude<ScanToolKind, "select">;

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
  /** The classes a polyline may be drawn as: those that declare `polyline_3d`. */
  readonly polylineClasses: readonly LabelClass[];
  readonly polylineClass: string | null;
  readonly setPolylineClass: (labelClass: string) => void;
  /** Why each drawing tool cannot draw, or `null` when it can. */
  readonly toolBlocked: Readonly<Record<ScanDrawKind, string | null>>;
  /** Why the picked drawing tool cannot draw; `null` when it can, or when Select is picked. */
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
export const NO_POLYLINE_CLASS_REASON = "No class in this schema accepts a 3D polyline.";

const NO_CLASSES: readonly LabelClass[] = [];

/** The classes declaring `geometry`, and the one a tool draws as: the pick while it is declared, else the first. */
function useDrawClass(
  store: AnnotatorStore<ScanDocument> | null,
  geometry: GeometryType,
): { classes: readonly LabelClass[]; labelClass: string | null; setLabelClass: (labelClass: string) => void } {
  const classes = useMemo(
    () => (store === null ? NO_CLASSES : store.document.schema.classes.filter((declared) => declared.geometries.includes(geometry))),
    [store, geometry],
  );
  const [picked, setLabelClass] = useState<string | null>(null);
  const labelClass = picked !== null && classes.some((one) => one.name === picked) ? picked : (classes[0]?.name ?? null);
  return { classes, labelClass, setLabelClass };
}

/** The frame's scan store and its record of the server, when a `FrameSession` holds them. */
export interface ScanSession {
  readonly store: AnnotatorStore<ScanDocument>;
  readonly server: readonly WireAnnotation[];
  readonly minted: ReadonlyMap<string, string>;
}

export function useScanWorkspace({
  asset,
  schema,
  loaded,
  readOnly,
  session,
}: {
  readonly asset: ScanWorkspaceAsset;
  /** The pinned schema as the wire sent it; the store parses it. */
  readonly schema: unknown;
  readonly loaded: readonly WireAnnotation[];
  readonly readOnly: boolean;
  /** The page's frame session; absent, the hook keeps its own store. */
  readonly session?: ScanSession | null;
}): ScanWorkspace | null {
  const isScan = asset.modality === "point_cloud";
  const held = session?.store ?? null;
  const own = useMemo(
    () =>
      isScan && session === undefined
        ? new AnnotatorStore<ScanDocument>(
            scanDocumentFromWire({
              asset: { id: asset.id, width: 0, height: 0, modality: "point_cloud" },
              schema,
              annotations: loaded,
            }),
          )
        : null,
    [isScan, session, asset.id, schema, loaded],
  );
  const store = isScan ? (held ?? own) : null;
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

  const cuboid = useDrawClass(store, "cuboid_3d");
  const polyline = useDrawClass(store, "polyline_3d");
  const toolBlocked = useMemo<Record<ScanDrawKind, string | null>>(
    () => ({
      cuboid: cuboid.labelClass === null ? NO_CUBOID_CLASS_REASON : null,
      polyline: polyline.labelClass === null ? NO_POLYLINE_CLASS_REASON : null,
    }),
    [cuboid.labelClass, polyline.labelClass],
  );
  const [pickedTool, setToolKind] = useState<ScanToolKind>("select");
  const drawBlocked = pickedTool === "select" ? null : toolBlocked[pickedTool];
  const toolKind: ScanToolKind = drawBlocked === null ? pickedTool : "select";
  const drawClass = toolKind === "cuboid" ? cuboid.labelClass : toolKind === "polyline" ? polyline.labelClass : null;
  const tool = useMemo<ScanTool>(
    () => (toolKind === "select" || drawClass === null ? { kind: "select" } : { kind: toolKind, labelClass: drawClass }),
    [toolKind, drawClass],
  );

  const [groundHeight, setGroundHeight] = useState(0);
  const editor = useScanEditor({
    store,
    frame: editability.editable ? editability.frame : null,
    groundHeight,
    tool,
    enabled: editing,
  });

  const server = session?.server ?? loaded;
  const minted = session?.minted;
  const plan = useMemo(
    () => (snapshot === null ? EMPTY_PLAN : planScanSave(snapshot.document, server, minted)),
    [snapshot, server, minted],
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
    cuboidClasses: cuboid.classes,
    cuboidClass: cuboid.labelClass,
    setCuboidClass: cuboid.setLabelClass,
    polylineClasses: polyline.classes,
    polylineClass: polyline.labelClass,
    setPolylineClass: polyline.setLabelClass,
    toolBlocked,
    drawBlocked,
    groundHeight,
    setGroundHeight,
    editor,
    plan,
    remove,
  };
}
