// A two-line option needs the closed trigger to grow and to stop clamping its
// value; both overrides name canonical's own variants so the merge replaces them.
export const twoLineTrigger =
  "data-[size=default]:h-auto min-h-8 *:data-[slot=select-value]:line-clamp-none";
