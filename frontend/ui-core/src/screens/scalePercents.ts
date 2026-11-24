/** Every size the server stores at: 10% to 100% per side, in steps of 5, largest first. */
export const SCALE_PERCENTS: readonly number[] = Array.from({ length: 19 }, (_, at) => 100 - at * 5);
