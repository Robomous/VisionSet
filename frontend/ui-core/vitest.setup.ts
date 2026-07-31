/**
 * Unmount between tests.
 *
 * `@testing-library/react` registers this itself when a runner exposes `afterEach`
 * as a global. This suite runs with `globals: false` — imports in a test file
 * should say what the file uses — so the hook has to be registered by hand.
 *
 * Without it every render accumulates in one `document.body` and a query like
 * `getByRole("alert")` starts failing with "found multiple elements" in whichever
 * test happens to run second. That is a harness bug that reads exactly like a
 * component bug, which is why it is worth a file and a comment.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
