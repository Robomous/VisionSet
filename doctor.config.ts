/**
 * React Doctor's settings for the frontend workspace (`pnpm doctor`, the PR
 * workflow and the local hook read this file).
 *
 * Every entry here is a decision, not a convenience: a suppression names the
 * file, the rule and why the rule's advice does not hold there. A new entry is
 * raised in review like any other weakened check (`AGENTS.md`).
 */

// Type-only: the loader cannot resolve `defineConfig` at runtime, so the
// object is exported as is and only checked against the config's type.
import type { ReactDoctorConfig } from "react-doctor";

export default {
  ignore: {
    overrides: [
      {
        // `morphHeight` animates a dialog body's `height` on purpose: only the
        // height can carry the dialog's frame when a press swaps what it holds
        // (New model's Local ↔ Remote), and a scale would squash every word in
        // it. It runs on a press, never on data arriving, so layout pays for it
        // once in a while. The rest of the rule — and every other file — still
        // applies. `lib/motion.ts` says the same beside the code.
        files: ["src/lib/motion.ts"],
        rules: ["react-doctor/no-layout-property-animation"],
      },
      {
        // The suggestion and detection asks are mutations that write nothing:
        // the ask is an event, not a cache entry, and acceptance is a separate
        // ordinary annotation create that invalidates what it touches. An
        // invalidation here would refetch data nothing changed.
        files: ["src/data/inferenceQueries.ts"],
        rules: ["react-doctor/query-mutation-missing-invalidation"],
      },
    ],
  },
} satisfies ReactDoctorConfig;
