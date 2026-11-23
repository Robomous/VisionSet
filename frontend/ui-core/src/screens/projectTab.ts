/**
 * Which section a raw `?tab=` value means. Pure, and kept apart from the
 * screen's component so that file exports components only.
 */

import { DEFAULT_PROJECT_SECTION, PROJECT_SECTIONS, type ProjectSection } from "../patterns/projectSections";

/**
 * What a raw `?tab=` value resolves to, including the ones that have moved.
 *
 * Pure and exported because the *host* has to know: `ui-core` never imports a
 * router, so rewriting a stale URL is the app's job, and it can only do that if
 * it can ask what the value became without rendering anything.
 *
 * Returns `null` for a value that is already canonical, so a caller can tell "no
 * rewrite needed" from "rewrite to overview" without comparing strings itself.
 */
export function resolveProjectTab(raw: string | undefined): ProjectSection | null {
  if (raw === undefined) return null;
  if (raw === "versions") return "schema";
  return PROJECT_SECTIONS.includes(raw as ProjectSection) ? null : DEFAULT_PROJECT_SECTION;
}
