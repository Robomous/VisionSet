/**
 * The demo's schema: six classes chosen so that pressing 1–6 walks every branch
 * the engine has.
 *
 * The **order is the fixture**, the way `core/input/_palette.ts` says of its own:
 * `classHotkeys` binds digit N to class N in authored order, so what each digit
 * proves is decided here.
 *
 * | digit | class | what it exercises |
 * | --- | --- | --- |
 * | 1 | `vehicle` (bbox) | the bbox tool |
 * | 2 | `lane` (polygon) | the polygon tool, and a real tool change from 1 |
 * | 3 | `daytime` (tag) | `toggle-tag` — a panel row, never the canvas |
 * | 4 | `pedestrian` (bbox) | a **second** bbox class: 1 → 4 must not abandon a half-drawn box |
 * | 5 | `centerline` (polyline) | the polyline tool |
 * | 6 | `pose` (keypoints) | a geometry no annotation can carry — `select`, and nothing drawable |
 *
 * The sixth is the one that looks like a mistake and is not. `keypoints` is a legal
 * `GeometryType` for a `LabelClass` and is not one of the four an `Annotation` can
 * carry; `toolFor` answers `select` for it, and `drawableGeometry` answers `null`.
 * Keeping it here is what makes the demo show that state rather than pretend it
 * cannot happen.
 *
 * `centerline` cannot hold that role, because `polyline` has a tool. The role sits
 * rather than being deleted with the case — the same move `core/input/_palette.ts`
 * made, one package over, and for the same reason: it is a real state a schema can
 * be in, and the demo exists to show the states.
 *
 * Written as a plain object and parsed by `documentFromWire`, not built with
 * `createDocument`: this is the shape `GET /projects/{id}/schema` returns, so the
 * demo goes through the same parser a real host would and a drifted mirror would
 * fail here first.
 */

export const SAMPLE_SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
    { name: "daytime", geometries: ["classification_tag"], color: "#a3e635", attributes: [] },
    // No colour: `classColor` derives a stable hue from the name instead, which is
    // the branch `LabelClass.color`'s own docstring blesses.
    { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] },
    { name: "centerline", geometries: ["polyline"], color: "#c084fc", attributes: [] },
    { name: "pose", geometries: ["keypoints"], color: "#facc15", attributes: [] },
  ],
} as const;
