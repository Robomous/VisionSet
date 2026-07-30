/**
 * The `IdFactory` every host on a platform with `crypto` wants.
 *
 * It lives in `adapters/` and not in `core/` for one reason: `crypto` is a host
 * global, and `src/core/` compiles with no DOM `lib` and no ambient `@types`, so
 * this file could not exist there. `adapters/` is where the DOM is allowed —
 * this one is not a *renderer*, which is why it sits beside `react/` rather than
 * inside it.
 *
 * `crypto.randomUUID()` is a v4 from a cryptographic source, and it is not a
 * detail: ids are compared across a session and must not collide, and a
 * `Math.random()` v4 collides sooner than people expect. Available in every
 * current browser and in Node 19+, though a browser requires a **secure
 * context** — https or localhost. A host serving plain http over a LAN needs its
 * own factory, which is exactly what the port is for.
 */

import type { IdFactory } from "../core/ids";

/** A fresh uuid v4 from the platform's own cryptographic source. */
export const randomUuid: IdFactory = () => crypto.randomUUID();
