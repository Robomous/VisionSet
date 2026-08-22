/**
 * Unmount between tests. The runner exposes no globals here (`globals: false`),
 * so `@testing-library/react` cannot register its own `cleanup` and it is
 * registered by hand — the same harness rule `ui-core`'s setup states at length.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
