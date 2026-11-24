/**
 * A WebGL2 view of one scan and its 3D labels, in the scan's declared frame.
 *
 * Drag orbits about the frame's up axis, a right or middle drag (or shift-drag)
 * pans, the wheel zooms; with the view focused, the arrows orbit, `+`/`-` zoom
 * and `0` resets. It draws on demand, never in a loop.
 *
 * `editing` hands the primary button to the host through `onScanPointer`, with
 * the camera and the CSS-pixel viewport the press was made against; orbit moves
 * to the right button and pan to the middle one (or shift + right). The view
 * edits nothing itself.
 *
 * `pinned` makes it the top-down view: an orthographic camera straight down the
 * up axis (`topDownCamera`) that follows `followTarget` and never orbits; the
 * orbit drag pans it and the wheel zooms it.
 *
 * The canvas is created inside the effect rather than rendered, so every mount
 * owns a fresh context it can release on unmount: a context once lost through
 * `WEBGL_lose_context` cannot be asked for again on the same element, which is
 * what a remount of a rendered `<canvas>` would do.
 */

import { useCallback, useEffect, useRef, type JSX } from "react";

import {
  framingBounds,
  homeCamera,
  orbit,
  pan,
  sceneRadius,
  topDownCamera,
  viewProjection,
  zoom,
  type OrbitCamera,
} from "../../core/pointcloud/camera";
import { boundsOf, type PointBounds, type PointSample } from "../../core/pointcloud/decode";
import { scanPointerRole, type ScanPointerRole } from "../../core/pointcloud/edit/input";
import type { ScanEvent } from "../../core/pointcloud/edit/machine";
import type { ScanViewKind } from "../../core/pointcloud/edit/scene";
import type { ScanFrame } from "../../core/pointcloud/frame";
import { segmentsRelativeTo } from "../../core/pointcloud/labels";
import { pointColors, type ColorMode } from "../../core/pointcloud/ramp";
import type { ScanViewport } from "../../core/pointcloud/ray";
import type { Point3D } from "../../core/types";
import { PointCloudRenderer, cssColorToRgb, resolveCssColor } from "./pointCloudGl";

export interface PointCloudLabel {
  readonly id: string;
  /** A CSS colour as the schema's palette spells it. */
  readonly color: string;
  /** `x, y, z` per vertex, two vertices a segment, in the scan's frame. */
  readonly segments: Float32Array | Float64Array;
  /** Drawn in `highlightColor`, over every other label. */
  readonly emphasis?: "selected" | "draft";
}

/** What a screen point means: the camera and the CSS-pixel viewport it was seen through. */
export interface ScanView {
  readonly camera: OrbitCamera;
  readonly viewport: ScanViewport;
  /** Absent means `perspective`. */
  readonly kind?: ScanViewKind;
}

export type ScanPointerEvent = Extract<
  ScanEvent,
  { readonly type: "pointer-down" | "pointer-move" | "pointer-up" | "pointer-cancel" }
>;

/** `unsupported`: this browser offers no WebGL2. `lost`: the context was taken and may come back. */
export type PointCloudStatus = "ready" | "unsupported" | "lost";

export interface PointCloudCanvasProps {
  readonly sample: PointSample;
  readonly frame: ScanFrame;
  readonly colorMode: ColorMode;
  readonly labels: readonly PointCloudLabel[];
  readonly showLabels: boolean;
  /** Any change puts the camera back where it started. */
  readonly resetSignal?: number;
  readonly onStatusChange?: (status: PointCloudStatus) => void;
  readonly ariaLabel?: string;
  /** Primary presses go to `onScanPointer` instead of orbiting. */
  readonly editing?: boolean;
  readonly onScanPointer?: (event: ScanPointerEvent, view: ScanView) => void;
  /** After every camera move or resize, and once the view first has a size. */
  readonly onCameraChange?: (view: ScanView) => void;
  /** Any CSS colour, `var()` included; the colour of an emphasised label. */
  readonly highlightColor?: string;
  /** The top-down view: a pinned camera that follows `followTarget`. */
  readonly pinned?: boolean;
  readonly followTarget?: Point3D;
  readonly testIds?: { readonly view: string; readonly canvas: string };
}

const ROTATE_PER_PX = 0.008;
const KEY_ROTATE = (5 * Math.PI) / 180;
const KEY_ZOOM = 1.2;
const WHEEL_ZOOM_PER_PX = 0.0015;
const LINE_PX = 16;
const POINT_PX = 2;
const UNIT_BOUNDS: PointBounds = { minimum: [-1, -1, -1], maximum: [1, 1, 1] };

interface Live {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  renderer: PointCloudRenderer | null;
}

export function PointCloudCanvas(props: PointCloudCanvasProps): JSX.Element {
  const { sample, frame, colorMode, labels, showLabels, resetSignal, highlightColor, editing = false, pinned = false } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Live | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const cameraRef = useRef<OrbitCamera | null>(null);
  const sceneRef = useRef<Scene>(UNIT_SCENE);
  const frameRequest = useRef<number | null>(null);
  const draws = useRef(0);

  const homeOf = useCallback((): OrbitCamera => {
    const { home } = sceneRef.current;
    const current = propsRef.current;
    return current.pinned === true ? topDownCamera(current.followTarget ?? home.target, home.distance) : home;
  }, []);

  const drawNow = useCallback((): void => {
    frameRequest.current = null;
    const live = liveRef.current;
    const camera = cameraRef.current;
    const host = hostRef.current;
    if (live === null || live.renderer === null || camera === null || host === null) return;
    const { canvas } = live;
    const current = propsRef.current;
    const { depthRadius, home } = sceneRef.current;
    const panned = Math.hypot(
      camera.target[0] - home.target[0],
      camera.target[1] - home.target[1],
      camera.target[2] - home.target[2],
    );
    const aspect = canvas.width / Math.max(1, canvas.height);
    const matrix = viewProjection(camera, current.frame, aspect, depthRadius + panned, current.sample.origin);
    live.renderer.draw(matrix, canvas.width, canvas.height, POINT_PX * pixelRatio(), current.showLabels);
    draws.current += 1;
    host.dataset["draws"] = String(draws.current);
  }, []);

  const requestDraw = useCallback((): void => {
    if (frameRequest.current === null) frameRequest.current = requestAnimationFrame(drawNow);
  }, [drawNow]);

  const uploadPositions = useCallback((renderer: PointCloudRenderer): void => {
    renderer.setPositions(propsRef.current.sample.positions);
  }, []);

  const uploadColors = useCallback((renderer: PointCloudRenderer): void => {
    const current = propsRef.current;
    renderer.setColors(pointColors(current.sample, current.colorMode, current.frame));
  }, []);

  const uploadLabels = useCallback((renderer: PointCloudRenderer): void => {
    const current = propsRef.current;
    const host = hostRef.current;
    const plain = current.labels.filter((label) => label.emphasis === undefined);
    const emphasised = current.labels.filter((label) => label.emphasis !== undefined);
    const highlight =
      emphasised.length === 0 || host === null ? null : resolveCssColor(host, current.highlightColor ?? "currentColor");
    const { origin } = current.sample;
    renderer.setLabels([
      ...plain.map((label) => ({ color: cssColorToRgb(label.color), segments: segmentsRelativeTo(label.segments, origin) })),
      ...emphasised.map((label) => ({
        color: highlight ?? cssColorToRgb(label.color),
        segments: segmentsRelativeTo(label.segments, origin),
      })),
    ]);
  }, []);

  const notifyCamera = useCallback((): void => {
    const camera = cameraRef.current;
    const canvas = liveRef.current?.canvas;
    if (camera === null || canvas === undefined || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return;
    propsRef.current.onCameraChange?.({
      camera,
      viewport: { width: canvas.clientWidth, height: canvas.clientHeight },
      kind: propsRef.current.pinned === true ? "top-down" : "perspective",
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const report = (status: PointCloudStatus): void => {
      host.dataset["status"] = status;
      propsRef.current.onStatusChange?.(status);
    };

    const canvas = document.createElement("canvas");
    canvas.className = "block size-full touch-none outline-none";
    canvas.tabIndex = 0;
    canvas.dataset["testid"] = propsRef.current.testIds?.canvas ?? "point-cloud-gl";
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-roledescription", "3D view");
    if (propsRef.current.ariaLabel !== undefined) canvas.setAttribute("aria-label", propsRef.current.ariaLabel);
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
    if (gl === null) {
      report("unsupported");
      return;
    }
    host.appendChild(canvas);
    const live: Live = { canvas, gl, renderer: null };
    liveRef.current = live;

    const start = (): boolean => {
      try {
        const renderer = new PointCloudRenderer(gl);
        uploadPositions(renderer);
        uploadColors(renderer);
        uploadLabels(renderer);
        live.renderer = renderer;
        return true;
      } catch {
        return false;
      }
    };

    const resize = (): void => {
      const ratio = pixelRatio();
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      drawNow();
      notifyCamera();
    };

    const onLost = (event: Event): void => {
      event.preventDefault();
      live.renderer = null;
      if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current);
      frameRequest.current = null;
      report("lost");
    };
    const onRestored = (): void => {
      if (!start()) {
        report("unsupported");
        return;
      }
      report("ready");
      drawNow();
    };

    const camera = (next: (current: OrbitCamera) => OrbitCamera): void => {
      if (cameraRef.current === null) return;
      cameraRef.current = next(cameraRef.current);
      requestDraw();
      notifyCamera();
    };

    const scanView = (): ScanView | null => {
      const current = cameraRef.current;
      if (current === null || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return null;
      return {
        camera: current,
        viewport: { width: canvas.clientWidth, height: canvas.clientHeight },
        kind: propsRef.current.pinned === true ? "top-down" : "perspective",
      };
    };
    const tell = (event: ScanPointerEvent): void => {
      const view = scanView();
      if (view !== null) propsRef.current.onScanPointer?.(event, view);
    };
    const pointOf = (event: PointerEvent): readonly [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    const modifiersOf = (event: PointerEvent) => ({
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
    });

    let drag: { readonly id: number; x: number; y: number; readonly role: ScanPointerRole } | null = null;
    const onPointerDown = (event: PointerEvent): void => {
      if (drag !== null) return;
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      const editing = propsRef.current.editing === true && propsRef.current.onScanPointer !== undefined;
      const role = scanPointerRole(event.button, event.shiftKey, editing, propsRef.current.pinned === true);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, role };
      if (role === "edit") {
        tell({ type: "pointer-down", point: pointOf(event), button: "primary", modifiers: modifiersOf(event) });
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (drag === null) {
        if (propsRef.current.editing === true) tell({ type: "pointer-move", point: pointOf(event) });
        return;
      }
      if (drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      switch (drag.role) {
        case "edit":
          tell({ type: "pointer-move", point: pointOf(event) });
          break;
        case "pan":
          camera((c) => pan(c, propsRef.current.frame, dx, dy, canvas.clientHeight));
          break;
        case "orbit":
          camera((c) => orbit(c, -dx * ROTATE_PER_PX, dy * ROTATE_PER_PX));
          break;
      }
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (drag === null || drag.id !== event.pointerId) return;
      const { role } = drag;
      drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (role !== "edit") return;
      if (event.type === "pointercancel") tell({ type: "pointer-cancel" });
      else tell({ type: "pointer-up", point: pointOf(event), button: "primary", modifiers: modifiersOf(event) });
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * LINE_PX : event.deltaY;
      camera((c) => zoom(c, Math.exp(delta * WHEEL_ZOOM_PER_PX), sceneRef.current.zoomRadius));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const radius = sceneRef.current.zoomRadius;
      if (propsRef.current.pinned === true && event.key.startsWith("Arrow")) return;
      switch (event.key) {
        case "ArrowLeft":
          camera((c) => orbit(c, KEY_ROTATE, 0));
          break;
        case "ArrowRight":
          camera((c) => orbit(c, -KEY_ROTATE, 0));
          break;
        case "ArrowUp":
          camera((c) => orbit(c, 0, KEY_ROTATE));
          break;
        case "ArrowDown":
          camera((c) => orbit(c, 0, -KEY_ROTATE));
          break;
        case "+":
        case "=":
          camera((c) => zoom(c, 1 / KEY_ZOOM, radius));
          break;
        case "-":
        case "_":
          camera((c) => zoom(c, KEY_ZOOM, radius));
          break;
        case "0":
          camera(homeOf);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    const onContextMenu = (event: Event): void => event.preventDefault();

    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("contextmenu", onContextMenu);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);

    if (!gl.isContextLost() && start()) {
      report("ready");
      resize();
    } else {
      report(gl.isContextLost() ? "lost" : "unsupported");
    }

    return () => {
      observer?.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("contextmenu", onContextMenu);
      if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current);
      frameRequest.current = null;
      live.renderer?.dispose();
      live.renderer = null;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      if (liveRef.current === live) liveRef.current = null;
    };
  }, [drawNow, requestDraw, uploadPositions, uploadColors, uploadLabels, notifyCamera, homeOf]);

  useEffect(() => {
    sceneRef.current = sceneOf(sample);
    cameraRef.current = homeOf();
    const renderer = liveRef.current?.renderer;
    if (renderer) uploadPositions(renderer);
    requestDraw();
    notifyCamera();
  }, [sample, frame, uploadPositions, requestDraw, notifyCamera, homeOf]);

  useEffect(() => {
    const renderer = liveRef.current?.renderer;
    if (renderer) uploadColors(renderer);
    requestDraw();
  }, [sample, frame, colorMode, uploadColors, requestDraw]);

  useEffect(() => {
    const renderer = liveRef.current?.renderer;
    if (renderer) uploadLabels(renderer);
    requestDraw();
  }, [sample, labels, highlightColor, uploadLabels, requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [showLabels, requestDraw]);

  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    cameraRef.current = homeOf();
    requestDraw();
    notifyCamera();
  }, [resetSignal, requestDraw, notifyCamera, homeOf]);

  const [followX, followY, followZ] = props.followTarget ?? [NaN, NaN, NaN];
  useEffect(() => {
    const target = propsRef.current.followTarget;
    if (propsRef.current.pinned !== true || target === undefined || cameraRef.current === null) return;
    cameraRef.current = { ...cameraRef.current, target };
    requestDraw();
    notifyCamera();
  }, [followX, followY, followZ, requestDraw, notifyCamera]);

  useEffect(() => {
    const canvas = liveRef.current?.canvas;
    if (canvas !== undefined) canvas.style.cursor = editing ? "crosshair" : "";
  }, [editing]);

  return (
    <div
      ref={hostRef}
      className="relative size-full"
      data-testid={props.testIds?.view ?? "point-cloud-canvas"}
      data-scan-view={pinned ? "top-down" : "perspective"}
      data-color-mode={colorMode}
      data-labels={showLabels ? "on" : "off"}
      data-label-count={labels.length}
      data-editing={editing ? "on" : "off"}
    />
  );
}

/**
 * Where the camera starts, and the radii it moves within: zoom is bounded by the
 * framed body of the scan, the depth planes by every point, stray ones included.
 */
interface Scene {
  readonly home: OrbitCamera;
  readonly zoomRadius: number;
  readonly depthRadius: number;
}

const UNIT_SCENE: Scene = { home: homeCamera(UNIT_BOUNDS), zoomRadius: 1, depthRadius: 1 };

function sceneOf(sample: PointSample): Scene {
  const framed = framingBounds(sample.positions, sample.origin) ?? UNIT_BOUNDS;
  return {
    home: homeCamera(framed),
    zoomRadius: sceneRadius(framed),
    depthRadius: sceneRadius(boundsOf(sample.positions) ?? UNIT_BOUNDS),
  };
}

function pixelRatio(): number {
  return typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
}
