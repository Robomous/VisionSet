/**
 * What a back affordance calls its parent while the parent's name is in flight.
 *
 * Every sub-view of a project can name its parent — `useProject` is already
 * cached by the time somebody has walked into a child — but "already cached" is
 * not "always": a deep link or a reload opens the child with nothing loaded, and a
 * control that appeared as an arrow and then grew a name would move the page under
 * the cursor at exactly the moment somebody is aiming at it.
 *
 * So the noun is the floor, never the empty string: the affordance is the same
 * shape from the first paint, and gains precision rather than width.
 */
export function parentLabel(name: string | undefined, noun = "Project"): string {
  return name ?? noun;
}
