/**
 * Which ports this worktree's browser suites bind, and where the numbers come from.
 *
 * ## Why a derivation and not three constants
 *
 * `refactor-protocol` puts every task in its own git worktree, so several checkouts of
 * this repository run their gates on one machine at the same time. That is the normal
 * working mode here, not an edge case — and three fixed ports made the browser suites
 * single-occupancy. The second `scripts/check.sh` to reach the browser group found 5273
 * held and died with `Port 5273 is already in use`, which reads as a broken dev server
 * rather than as contention.
 *
 * So a port joins the rest of a worktree's disjoint surface, beside its branch and its
 * `dist/`: derived from the worktree's own absolute path, stable for as long as that
 * path is, and different from every neighbour's.
 *
 * The two alternatives, recorded so they are not re-opened. **Bind port 0 and discover
 * it** gives up a stable `baseURL` — `playwright.cycle.config.ts` hands its port to a
 * shell script through `webServer.env`, and a number nobody can predict is a number
 * nobody can type into a browser to look at a failure. **A lock file** serializes two
 * runs that have no reason to wait for each other, which is the opposite of what the
 * worktree model is for.
 *
 * ## The main checkout keeps the numbers it had
 *
 * A linked worktree derives; the main checkout does not, and neither does CI, whose
 * clone is a main checkout too. One branch, and it buys a lot: `docs/`, muscle memory
 * and every CI log go on saying 5273 and go on being right, and a contributor with a
 * single checkout sees no change at all. Git's own distinction is the signal — `.git`
 * is a *directory* in the main checkout and a *file* in a linked worktree — so nothing
 * needs configuring and no path has to be treated as canonical, which is just as well:
 * where somebody clones this repository is their business.
 *
 * Stated, because it is the one hole this leaves: two independent *clones* are both
 * main checkouts, so both take the legacy numbers and collide. The override below is
 * what that case is for.
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The three browser suites that bind a port, each with a band of its own. */
export type Suite = "e2e" | "cycle" | "bench";

export const SUITES: readonly Suite[] = ["e2e", "cycle", "bench"];

/**
 * How many slots a worktree can hash into.
 *
 * 2048 puts eight concurrent worktrees at roughly a 1.4% chance that any two land on
 * the same one — and a shared slot is a refusal carrying a message, never a wrong
 * answer, because every server here binds with `--strictPort` and `assertFree` runs
 * first.
 */
export const SLOTS = 2048;

/**
 * The floor of each suite's band. Contiguous, and each exactly `SLOTS` wide.
 *
 * That width is the point: two worktrees share a *port* only if they share a *slot*, in
 * which case they share all three, so a collision is total and legible rather than one
 * suite mysteriously clashing while its siblings are fine.
 *
 * The window is 16384–22527 and both edges are chosen rather than inherited. Above the
 * 3000–9000 range where a developer's own servers live, which is the contention this
 * exists to end — and below **32768**, the floor of Linux's ephemeral port range: a
 * fixed listener above that line can lose the number to an outbound connection that
 * borrowed it first, intermittently and for a reason nothing in the failure mentions.
 * macOS starts its ephemeral range at 49152, so Linux's floor is the binding one.
 */
export const BAND: Readonly<Record<Suite, number>> = {
  e2e: 16384,
  cycle: 18432,
  bench: 20480,
};

/** What the main checkout binds, which is what these three suites always bound. */
export const LEGACY: Readonly<Record<Suite, number>> = {
  e2e: 5273,
  cycle: 8123,
  bench: 5373,
};

/**
 * The escape hatch, one per suite. The cycle server script reads
 * `VISIONSET_CYCLE_PORT`, and `playwright.cycle.config.ts` passes it down.
 */
export const OVERRIDE: Readonly<Record<Suite, string>> = {
  e2e: "VISIONSET_E2E_PORT",
  cycle: "VISIONSET_CYCLE_PORT",
  bench: "VISIONSET_BENCH_PORT",
};

/**
 * The slot a path hashes into.
 *
 * SHA-256 rather than a hand-rolled string hash, for one property that matters more
 * than speed at config-load time: neighbouring paths must not land in neighbouring
 * slots. Sibling worktrees differ by a few characters at the end — `visionset-a`,
 * `visionset-b` — and an additive or FNV-style hash spreads those over a handful of
 * adjacent values, which is exactly the population this has to keep apart.
 */
export function slotFor(root: string): number {
  return createHash("sha256").update(root).digest().readUInt32BE(0) % SLOTS;
}

export interface PortOptions {
  /** A linked worktree derives; a main checkout keeps `LEGACY`. */
  linked: boolean;
  /** Defaults to the real environment; a parameter so a test needs no global. */
  env?: Record<string, string | undefined>;
}

/** Every suite's port for one worktree root, overrides applied. */
export function portsFor(root: string, options: PortOptions): Record<Suite, number> {
  const env = options.env ?? process.env;
  const slot = slotFor(root);
  const ports = {} as Record<Suite, number>;
  for (const suite of SUITES) {
    const stated = env[OVERRIDE[suite]];
    ports[suite] =
      stated === undefined || stated === ""
        ? options.linked
          ? BAND[suite] + slot
          : LEGACY[suite]
        : statedPort(suite, stated);
  }
  return ports;
}

/**
 * Refused rather than coerced. `Number("8080x")` is `NaN` and `Number("")` is `0`, and
 * either one silently becomes "let the OS choose" at a `listen` call — a suite that
 * quietly binds a random port is worse than one that will not start.
 */
function statedPort(suite: Suite, stated: string): number {
  const port = Number(stated);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${OVERRIDE[suite]}=${stated} is not a port number (want 1-65535).`);
  }
  return port;
}

/** `.git` is a directory in the main checkout and a file in a linked worktree. */
function isLinkedWorktree(root: string): boolean {
  try {
    return !statSync(path.join(root, ".git")).isDirectory();
  } catch {
    // An export with no `.git` at all is nobody's linked worktree.
    return false;
  }
}

/** This worktree's root — the module sits at `frontend/app/`, two levels down. */
export const ROOT = realpathSync(path.resolve(import.meta.dirname, "..", ".."));

export const LINKED = isLinkedWorktree(ROOT);

/** The resolved answer, which is what the three Playwright configs read. */
export const PORT = portsFor(ROOT, { linked: LINKED });

const listing = (): string => SUITES.map((suite) => `${suite} ${PORT[suite]}`).join(", ");

/**
 * One line on stderr, from the process that loads a config.
 *
 * It is what makes a later port error legible: the number in
 * `http://localhost:17115 is already used` is not one anybody chose, so a run that uses
 * a derived port has to say where the derivation came from. Playwright loads the config
 * in its workers too, and `TEST_WORKER_INDEX` is how a worker is told apart.
 */
export function announce(): void {
  if (process.env["TEST_WORKER_INDEX"] !== undefined) return;
  const where = LINKED ? `worktree slot ${slotFor(ROOT)}/${SLOTS}` : "main checkout";
  console.error(`[visionset] browser ports: ${listing()}  (${where}, ${ROOT})`);
}

/** Why a port being taken is a refusal rather than a puzzle. */
export function occupiedMessage(suite: Suite, port: number): string {
  return [
    `Port ${port} is already in use, and it is this worktree's ${suite} port.`,
    ``,
    `  worktree    ${ROOT}`,
    `  derivation  ${
      LINKED
        ? `slot ${slotFor(ROOT)} of ${SLOTS}, hashed from that path`
        : `none — a main checkout keeps the legacy ports`
    }`,
    `  this slot   ${listing()}`,
    ``,
    `That port belongs to this worktree alone, so the likeliest cause is a server an`,
    `earlier run left behind here:`,
    ``,
    `  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    ``,
    LINKED
      ? `The other possibility is a hash collision: another worktree on this machine\nderived the same slot, and its three ports are the three above.`
      : `The other possibility is a second clone of this repository — every main checkout\ntakes the same legacy ports, and only linked worktrees derive their own.`,
    ``,
    `Override with ${OVERRIDE[suite]}=<port>.`,
  ].join("\n");
}

/** Whether a TCP port on the loopback interface is free right now. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** Throw `occupiedMessage` unless the suite's port is free. */
export async function assertFree(suite: Suite): Promise<void> {
  const port = PORT[suite];
  if (await isFree(port)) return;
  throw new Error(occupiedMessage(suite, port));
}

function isSuite(value: string): value is Suite {
  return (SUITES as readonly string[]).includes(value);
}

/**
 * `node e2e-ports.ts --guard <suite>`, the first link of every `webServer.command`.
 *
 * A separate process rather than a check inside the config, and the reason is when each
 * one runs. A config is loaded for `--list` and for `show-report`, and again in every
 * worker — where the port is *supposed* to be held, by the server this very run just
 * started. `webServer.command` runs in exactly one situation: Playwright has decided to
 * launch a server and is about to. Putting the guard first in the chain also means the
 * refusal arrives before the three-package build rather than a minute after it.
 */
async function main(): Promise<void> {
  const [flag, name] = process.argv.slice(2);
  if (flag !== "--guard" || name === undefined || !isSuite(name)) {
    console.error(`usage: node e2e-ports.ts --guard <${SUITES.join("|")}>`);
    process.exitCode = 2;
    return;
  }
  await assertFree(name);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
