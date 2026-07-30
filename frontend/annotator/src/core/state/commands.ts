/**
 * The commands: labelled wrappers over the document's own operations.
 *
 * They add a name and nothing else. `addAnnotation`, `replaceAnnotation` and
 * `removeAnnotations` already own every invariant and every refusal — a command
 * that re-checked one would be the second spelling `wire.ts`'s rule 2 argues
 * against, and it would drift.
 *
 * ## Grouping is composition, not a protocol
 *
 * A command is already an arbitrary document transformation, so several of them
 * as one undo step is function composition threaded through the document, which
 * is all `composeCommands` is. It is exception-safe for free: `CommandLog.execute`
 * assigns and appends only after `apply` has returned, so a member throwing part
 * of the way through leaves both the document and the log untouched.
 *
 * There is deliberately **no `begin()`/`commit()`/`abort()` pair**. An open
 * transaction spanning pointer events is a state that an Escape, a thrown error or
 * a lost pointer capture can leave dangling, and nothing needs one: transient drag
 * state lives outside the log entirely, in `AnnotatorStore`'s staging area. #44's
 * "a whole polygon drawing session is one undo step" is served the same way — the
 * pending points are interaction state (#42), and closing the polygon is one
 * `addAnnotationCommand`.
 */

import {
  addAnnotation,
  removeAnnotations,
  replaceAnnotation,
} from "./document";
import type { AnnotationDocument } from "./document";
import type { Command } from "./commandLog";
import type { Annotation } from "../types";

/**
 * A command from a label and a document transformation. The primitive.
 *
 * Everything else here is a call to this one, and a tool with a transformation
 * these four do not cover uses it directly rather than growing a fifth factory.
 */
export function documentCommand(
  label: string,
  apply: (document: AnnotationDocument) => AnnotationDocument,
): Command {
  return { label, apply };
}

/**
 * Several commands as one undo step, applied in order.
 *
 * Each member sees the document the previous one produced, so a group may build
 * on itself. An empty group is the identity, which `CommandLog.execute`
 * deliberately does not record.
 */
export function composeCommands(
  label: string,
  commands: Iterable<Command>,
): Command {
  const members = [...commands];
  return {
    label,
    apply: (document) =>
      members.reduce((next, command) => command.apply(next), document),
  };
}

/** Add one annotation at the end of the draw order. */
export function addAnnotationCommand(annotation: Annotation): Command {
  return {
    label: `add ${annotation.label_class}`,
    apply: (document) => addAnnotation(document, annotation),
  };
}

/**
 * Replace one annotation whole, keeping its place in the draw order.
 *
 * The command a finished drag commits: the geometry it carries is the one the
 * pointer ended on, computed by the tool, not by the log.
 */
export function replaceAnnotationCommand(annotation: Annotation): Command {
  return {
    label: `edit ${annotation.label_class}`,
    apply: (document) => replaceAnnotation(document, annotation),
  };
}

/** Remove annotations by id. All or nothing, the document's own rule. */
export function removeAnnotationsCommand(ids: Iterable<string>): Command {
  // Materialized at construction: a command built from a live iterable and run
  // later would remove whatever the iterable had become by then.
  const wanted = [...ids];
  const what = wanted.length === 1 ? "annotation" : "annotations";
  return {
    label: `delete ${wanted.length} ${what}`,
    apply: (document) => removeAnnotations(document, wanted),
  };
}
