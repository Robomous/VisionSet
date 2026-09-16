// Proves the browser-models CI job actually ran the real EfficientSAM-Ti model.
//
// Run with: node scripts/browser_models/assert_tests_ran.mjs <playwright-json-report>
//
// The job's other guards all answer "did the thing that ran succeed?". This one answers the
// question a green check cannot otherwise distinguish: *did it run at all?* Playwright exits 0
// when every test skips, and it exits 0 when a spec file was renamed, moved out of `testDir`,
// excluded by a stray `--grep`, or handed a `test.skip()` nobody meant to leave in. In each of
// those cases the job that exists to prove the export works reports success having proved
// nothing, and no diff looks wrong.
//
// `VISIONSET_REQUIRE_BROWSER_MODELS=1` makes `efficientSam.spec.ts` throw when the artifacts
// are missing, which covers the common accident. It cannot cover a file that never loads — a
// module that is not imported cannot raise. So the same flag also makes the run emit a JSON
// report, and this reads it back and insists the real-model specs are present, passed, and were
// not skipped.
//
// The floor is deliberately a floor. Adding a test is fine and needs no edit here; removing one
// fails, and lowering MINIMUM_REAL_MODEL_SPECS is then a deliberate line in a diff that a
// reviewer can see, rather than silent erosion of the proof.
import { readFileSync } from "node:fs";

/** The spec whose tests load the exported graphs and run them in Chromium. */
export const REAL_MODEL_SPEC = "efficientSam.spec.ts";

/** Eleven at the time of writing. A floor, not an expectation of exactness. */
export const MINIMUM_REAL_MODEL_SPECS = 11;

/** Depth-first over Playwright's nested `suites`, flattening to `{ file, title, ok, statuses }`. */
function collectSpecs(node, inheritedFile) {
  const file = node.file ?? inheritedFile;
  const here = (node.specs ?? []).map((spec) => ({
    file: spec.file ?? file,
    title: spec.title,
    ok: spec.ok === true,
    statuses: (spec.tests ?? []).map((test) => test.status),
  }));
  const nested = (node.suites ?? []).flatMap((child) => collectSpecs(child, file));
  return [...here, ...nested];
}

/** Returns the list of reasons this report fails to prove a real-model run. Empty means proven. */
export function reasonsNotProven(report) {
  const reasons = [];

  for (const error of report.errors ?? []) {
    reasons.push(`the run reported a top-level error: ${error.message ?? JSON.stringify(error)}`);
  }

  const specs = collectSpecs({ suites: report.suites ?? [] }, undefined).filter((spec) =>
    (spec.file ?? "").endsWith(REAL_MODEL_SPEC),
  );

  if (specs.length < MINIMUM_REAL_MODEL_SPECS) {
    reasons.push(
      `expected at least ${MINIMUM_REAL_MODEL_SPECS} tests from ${REAL_MODEL_SPEC}, found ` +
        `${specs.length}. The real-model suite did not run — check that the file is still under ` +
        `the configured testDir and that no filter excluded it.`,
    );
  }

  for (const spec of specs) {
    if (spec.statuses.includes("skipped")) {
      reasons.push(`"${spec.title}" was skipped, and this run may not skip the real model.`);
    } else if (!spec.ok) {
      reasons.push(`"${spec.title}" did not pass (${spec.statuses.join(", ") || "no result"}).`);
    }
  }

  return reasons;
}

function main() {
  const reportPath = process.argv[2];
  if (reportPath === undefined) {
    console.error("usage: node scripts/browser_models/assert_tests_ran.mjs <json-report>");
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (cause) {
    console.error(
      `cannot read the Playwright JSON report at ${reportPath}: ${cause.message}\n\n` +
        "It is written only when VISIONSET_REQUIRE_BROWSER_MODELS=1, by the reporter list in\n" +
        "frontend/browser-inference/playwright.inference.config.ts. Its absence means the\n" +
        "browser suite did not run under the flag, which is itself the failure this checks for.",
    );
    process.exit(1);
  }

  const reasons = reasonsNotProven(report);
  if (reasons.length > 0) {
    console.error(
      `the browser-models job did not prove a real EfficientSAM-Ti run:\n` +
        reasons.map((reason) => `  - ${reason}`).join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `real EfficientSAM-Ti execution confirmed: every test in ${REAL_MODEL_SPEC} ran and passed.`,
  );
}

if (process.argv[1]?.endsWith("assert_tests_ran.mjs")) main();
