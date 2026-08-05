// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The browser suites' ports are derived from the worktree's path rather than written
// down, so the properties a constant gave away for free — it is the same number every
// time, it is a legal port, it is not somebody else's — now have to be asserted. #346.
//
// This imports the derivation from `frontend/app/e2e-ports.ts` directly. Node 24 strips
// the types on the way in, which is what lets one module serve both the three Playwright
// configs (native TypeScript) and this gate (plain `node --test`) with no second
// spelling and no build step between them.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BAND,
  LEGACY,
  LINKED,
  OVERRIDE,
  PORT,
  ROOT,
  SLOTS,
  SUITES,
  occupiedMessage,
  portsFor,
  slotFor,
} from "../../frontend/app/e2e-ports.ts";

/** Paths shaped like the ones `refactor-protocol` actually creates. */
const WORKTREES = [
  "/Users/dev/Develop/Robomous/VisionSet",
  "/Users/dev/Develop/Robomous/visionset-346-e2e-ports",
  "/Users/dev/Develop/Robomous/visionset-223-polyline-kernel",
  "/Users/dev/Develop/Robomous/visionset-a",
  "/Users/dev/Develop/Robomous/visionset-b",
  "/Users/dev/Develop/Robomous/visionset-c",
  "/home/runner/work/VisionSet/VisionSet",
  "/tmp/visionset",
];

const derived = (root) => portsFor(root, { linked: true, env: {} });

test("the same path always derives the same ports", () => {
  for (const root of WORKTREES) {
    assert.equal(slotFor(root), slotFor(root));
    assert.deepEqual(derived(root), derived(root));
  }
});

test("sibling worktrees, which differ in one character, land in unrelated slots", () => {
  // The population this has to keep apart is not random strings: it is a directory of
  // paths sharing a long prefix. An additive or FNV-style hash puts `visionset-a` and
  // `visionset-b` in adjacent slots, which is the one arrangement a *band* of ports
  // cannot save you from — adjacent slots are adjacent ports.
  const slots = ["-a", "-b", "-c"].map((suffix) =>
    slotFor(`/Users/dev/Develop/Robomous/visionset${suffix}`),
  );
  assert.equal(new Set(slots).size, 3, `siblings collided: ${slots.join(", ")}`);
  for (let i = 1; i < slots.length; i += 1) {
    assert.ok(
      Math.abs(slots[i] - slots[i - 1]) > 1,
      `sibling slots are adjacent, so their ports are too: ${slots.join(", ")}`,
    );
  }
});

test("distinct paths get distinct ports", () => {
  const seen = new Set(WORKTREES.map((root) => JSON.stringify(derived(root))));
  assert.equal(seen.size, WORKTREES.length);
});

test("every derived port is inside its own suite's band", () => {
  for (const root of WORKTREES) {
    const ports = derived(root);
    for (const suite of SUITES) {
      assert.ok(
        ports[suite] >= BAND[suite] && ports[suite] < BAND[suite] + SLOTS,
        `${suite} ${ports[suite]} is outside [${BAND[suite]}, ${BAND[suite] + SLOTS})`,
      );
    }
  }
});

test("the bands are disjoint, so one worktree's three servers cannot collide", () => {
  const floors = SUITES.map((suite) => BAND[suite]).sort((a, b) => a - b);
  for (let i = 1; i < floors.length; i += 1) {
    assert.ok(floors[i] - floors[i - 1] >= SLOTS, `bands overlap: ${floors.join(", ")}`);
  }
});

test("the whole window sits above the crowded range and below Linux's ephemeral floor", () => {
  // 32768 is the floor of `net.ipv4.ip_local_port_range` on a default Linux box. A
  // fixed listener above it can lose its number to an outbound connection that borrowed
  // it first — intermittently, and for a reason nothing in the failure mentions.
  for (const suite of SUITES) {
    assert.ok(BAND[suite] > 1024, `${suite} band reaches privileged ports`);
    assert.ok(BAND[suite] + SLOTS <= 32768, `${suite} band reaches the ephemeral range`);
  }
});

test("a main checkout keeps the ports these suites have always bound", () => {
  assert.deepEqual(portsFor(WORKTREES[0], { linked: false, env: {} }), {
    e2e: 5273,
    cycle: 8123,
    bench: 5373,
  });
  // And the legacy numbers are outside every band, so a derived port can never be
  // mistaken for the main checkout's.
  for (const suite of SUITES) {
    assert.ok(LEGACY[suite] < BAND[suite] || LEGACY[suite] >= BAND[suite] + SLOTS);
  }
});

test("an override wins over the derivation, and over the legacy ports", () => {
  for (const suite of SUITES) {
    for (const linked of [true, false]) {
      const ports = portsFor(WORKTREES[1], { linked, env: { [OVERRIDE[suite]]: "31000" } });
      assert.equal(ports[suite], 31000);
      // The other two are untouched, so one override is not three.
      for (const other of SUITES.filter((name) => name !== suite)) {
        assert.notEqual(ports[other], 31000);
      }
    }
  }
});

test("an empty override is no override, because that is what an unset shell variable is", () => {
  const ports = portsFor(WORKTREES[1], { linked: true, env: { VISIONSET_E2E_PORT: "" } });
  assert.equal(ports.e2e, derived(WORKTREES[1]).e2e);
});

test("an override that is not a port is refused rather than coerced", () => {
  // `Number("8080x")` is NaN and `Number("0")` is 0, and both become "let the OS pick"
  // at a `listen` call — a suite that quietly binds a random port is worse than one
  // that will not start.
  for (const stated of ["8080x", "0", "-1", "65536", "80.5", "  "]) {
    assert.throws(
      () => portsFor(WORKTREES[1], { linked: true, env: { VISIONSET_CYCLE_PORT: stated } }),
      /is not a port number/,
      `accepted ${JSON.stringify(stated)}`,
    );
  }
});

test("the refusal names the port, the worktree it came from, and the way out", () => {
  const message = occupiedMessage("e2e", PORT.e2e);
  assert.match(message, new RegExp(`\\b${PORT.e2e}\\b`));
  assert.ok(message.includes(ROOT), "the message does not say which worktree derived it");
  assert.ok(message.includes(OVERRIDE.e2e), "the message does not name the override");
  assert.match(message, /lsof/, "the message does not say how to find the occupant");
});

test("all three configs bind the derived port, and guard it before they build", async () => {
  // Without this the derivation could be perfect and unused: a number typed back into
  // one `webServer.command` would pass every assertion above. Importing the configs is
  // also the only check that they still load at all outside Playwright's own runner.
  const cases = [
    // `binds` is whether the command itself carries `--port`. The cycle server is told
    // through `VISIONSET_CYCLE_PORT` instead, which the next test covers.
    { file: "playwright.config.ts", suite: "e2e", guard: "--guard e2e", binds: true },
    { file: "playwright.cycle.config.ts", suite: "cycle", guard: "--guard cycle", binds: false },
    { file: "playwright.bench.config.ts", suite: "bench", guard: "--guard bench", binds: true },
  ];
  for (const { file, suite, guard, binds } of cases) {
    const config = (await import(`../../frontend/app/${file}`)).default;
    const port = String(PORT[suite]);
    assert.ok(
      config.use.baseURL.includes(`:${port}`),
      `${file}: baseURL ${config.use.baseURL} is not on ${port}`,
    );
    assert.ok(config.webServer.url.includes(`:${port}`), `${file}: webServer.url misses ${port}`);

    const command = [config.webServer.command].flat().join(" && ");
    // The url and the command are two separate places a number can be written, and a
    // literal in the *command* is the one that does the damage: Playwright would poll
    // the derived port while the server bound a different one, and the suite would
    // time out waiting for a server that started fine.
    const bound = [...command.matchAll(/--port[= ](\d+)/g)].map((match) => match[1]);
    assert.equal(bound.length > 0, binds, `${file}: unexpected number of --port flags`);
    for (const value of bound) {
      assert.equal(value, port, `${file}: the command binds ${value} while the suite drives ${port}`);
    }

    assert.ok(command.includes(guard), `${file}: the command does not run the port guard`);
    assert.ok(
      command.indexOf(guard) < command.indexOf("build"),
      `${file}: the guard runs after the build, so a taken port costs a build first`,
    );
  }
});

test("the cycle server is told the same port its suite will drive", async () => {
  // Two halves that can disagree: the config's `baseURL` and the environment
  // `cycle_server.sh` reads to decide what to bind.
  const config = (await import("../../frontend/app/playwright.cycle.config.ts")).default;
  assert.equal(config.webServer.env.VISIONSET_CYCLE_PORT, String(PORT.cycle));
});

test("this checkout resolves to a coherent set of ports", () => {
  // Whichever branch it took, the answer has to agree with itself — the one thing a
  // pure-function test above cannot cover, because it never reads the real path.
  assert.deepEqual(PORT, portsFor(ROOT, { linked: LINKED }));
  for (const suite of SUITES) {
    assert.ok(Number.isInteger(PORT[suite]) && PORT[suite] > 1024 && PORT[suite] < 65536);
  }
});
