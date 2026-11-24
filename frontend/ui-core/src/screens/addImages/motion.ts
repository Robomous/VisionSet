/**
 * The Add images dialog's motion, named once: the strong ease-out every
 * movement in it rides, and the press every button in it answers with.
 * Transform and opacity only, and nothing under reduced motion.
 */

/** The strong ease-out: fast off the mark, long settle. */
export const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/** A press: 0.97 in 100 ms, and only the scale and the fill move. */
export const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";
