/**
 * The image sheet's density choices and the grid each one lays out. Kept apart
 * from the sheet's components so that file exports components only.
 */

export type Density = "s" | "m" | "l";

export const COLUMNS: Record<Density, string> = {
  s: "grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]",
  m: "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]",
  l: "grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]",
};
