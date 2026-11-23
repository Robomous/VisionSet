/**
 * The scan editor's machine, driven from the view: each pointer event turns
 * `scanTransition` against the store's committed document and the camera the
 * press was made through, and its effects land in the store.
 *
 * The state is held in a ref as well as in React state, because two pointer
 * events can arrive before a render and the second must turn from the first's
 * result. Disabling the editor, or swapping the store or the tool, cancels
 * whatever gesture was under way, so a drag never outlives the mode it began in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IdFactory } from "../../core/ids";
import { SCAN_IDLE, draftCuboid, scanTransition, type ScanContext, type ScanEvent, type ScanState, type ScanTool } from "../../core/pointcloud/edit/machine";
import { runScanEffects } from "../../core/pointcloud/edit/runScanEffects";
import { DEFAULT_HIT_TOLERANCES_3D } from "../../core/pointcloud/edit/scene";
import type { ScanDocument } from "../../core/pointcloud/edit/scanDocument";
import type { ScanFrame } from "../../core/pointcloud/frame";
import type { AnnotatorStore } from "../../core/state/store";
import type { Cuboid3DGeometry } from "../../core/types";
import { randomUuid } from "../ids";
import type { ScanPointerEvent, ScanView } from "./PointCloudCanvas";

export interface ScanEditorOptions {
  readonly store: AnnotatorStore<ScanDocument> | null;
  /** `null` where the scan declares no frame; the editor is then inert. */
  readonly frame: ScanFrame | null;
  readonly groundHeight: number;
  readonly tool: ScanTool;
  readonly enabled: boolean;
  readonly mint?: IdFactory;
}

export interface ScanEditor {
  readonly state: ScanState;
  /** The box being drawn, for the view to preview. */
  readonly draft: Cuboid3DGeometry | null;
  /** The last camera the perspective view reported; the top-down view's reports are not kept here. */
  readonly view: ScanView | null;
  readonly onScanPointer: (event: ScanPointerEvent, view: ScanView) => void;
  readonly onCameraChange: (view: ScanView) => void;
  /** A pointer-free event: `cancel`, `commit`, `delete-selected`. */
  readonly send: (event: Extract<ScanEvent, { type: "cancel" | "commit" | "delete-selected" }>) => void;
}

const NO_VIEW: ScanView = {
  camera: { yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0] },
  viewport: { width: 1, height: 1 },
};

export function useScanEditor(options: ScanEditorOptions): ScanEditor {
  const { store, frame, groundHeight, tool, enabled, mint = randomUuid } = options;
  const [state, setState] = useState<ScanState>(SCAN_IDLE);
  const [view, setView] = useState<ScanView | null>(null);
  const stateRef = useRef<ScanState>(SCAN_IDLE);
  const viewRef = useRef<ScanView | null>(null);
  const live = enabled && store !== null && frame !== null;
  const toolKey = tool.kind === "cuboid" ? `cuboid:${tool.labelClass}` : tool.kind;

  const turn = useCallback(
    (event: ScanEvent, at: ScanView): void => {
      if (store === null || frame === null) return;
      const context: ScanContext = {
        document: store.document,
        selection: store.selection,
        frame,
        camera: at.camera,
        viewport: at.viewport,
        tool,
        groundHeight,
        tolerances: DEFAULT_HIT_TOLERANCES_3D,
        mint,
        ...(at.kind === undefined ? {} : { view: at.kind }),
      };
      const next = scanTransition(stateRef.current, event, context);
      stateRef.current = next.state;
      setState(next.state);
      runScanEffects(store, next.effects);
    },
    [store, frame, tool, groundHeight, mint],
  );

  useEffect(() => {
    if (stateRef.current.type === "idle") return;
    if (store !== null && frame !== null) {
      turn({ type: "cancel" }, viewRef.current ?? NO_VIEW);
    }
    stateRef.current = SCAN_IDLE;
    setState(SCAN_IDLE);
    // Only a change of mode, store or tool ends a gesture; `turn` follows them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, store, toolKey]);

  const onScanPointer = useCallback(
    (event: ScanPointerEvent, at: ScanView): void => {
      viewRef.current = at;
      if (live) turn(event, at);
    },
    [live, turn],
  );

  const onCameraChange = useCallback((at: ScanView): void => {
    if (at.kind === "top-down") return;
    viewRef.current = at;
    setView(at);
  }, []);

  const send = useCallback(
    (event: Extract<ScanEvent, { type: "cancel" | "commit" | "delete-selected" }>): void => {
      if (live) turn(event, viewRef.current ?? NO_VIEW);
    },
    [live, turn],
  );

  const draft = useMemo(() => (frame === null ? null : draftCuboid(state, { frame })), [state, frame]);
  return { state, draft, view, onScanPointer, onCameraChange, send };
}
