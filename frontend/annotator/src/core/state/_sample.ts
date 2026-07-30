/**
 * A document to run history over: one asset, two classes, annotations on demand.
 *
 * Shared by the four files that treat a document as the *setting* — the log, the
 * store, the property run and the selection. `document.test.ts` keeps its own
 * inline fixtures on purpose: there the document is the *subject*, and a test
 * about what `createDocument` refuses has to build the thing being refused in
 * front of the reader.
 *
 * The `_` prefix marks a harness, so `tsconfig.build.json` keeps it out of the
 * shipped engine and out of the headless boundary's type gate — the same
 * convention as `_fixture.ts` and `tests/server/_flow.py`.
 */

import { createDocument } from "./document";
import type { AnnotationDocument } from "./document";
import type { Annotation, AnnotationSchema, AssetDescriptor } from "../types";

export const ASSET: AssetDescriptor = { id: "asset-1", width: 640, height: 480 };

export const SCHEMA: AnnotationSchema = {
  project_id: "project-1",
  version: 1,
  classes: [
    { name: "sign", geometry: "bbox", color: "#ff0000", attributes: [] },
    { name: "lane", geometry: "polygon", color: null, attributes: [] },
  ],
};

/** A bbox annotation on the sample asset. `x` is the field the edits move. */
export function annotation(id: string, x = 0): Annotation {
  return {
    id,
    asset_id: ASSET.id,
    label_class: "sign",
    schema_version: SCHEMA.version,
    geometry: { type: "bbox", x, y: 0, width: 10, height: 10 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}

/** A document holding one annotation per id, in the order given. */
export function documentOf(...ids: readonly string[]): AnnotationDocument {
  return createDocument(ASSET, SCHEMA, ids.map((id) => annotation(id)));
}
